/**
 * Linked tables: a table can name a CSV/TSV source URL (`data.$feed`) —
 * a published Google Sheet, an internal BI export, any endpoint the
 * server operator has allow-listed via ORIM_FETCH_ALLOW. The source is
 * one-directional truth: refresh replaces columns and rows, diffing by
 * the first column's value so row ids — and everything bound to them
 * (cell-bound stickies, aggregates) — survive.
 */
import { parseDelimited, toGrid } from "@orim/convert";
import type { TableNode } from "@orim/schema";
import type { BoardStore } from "@orim/store";
import { api } from "./auth";

export interface FeedInfo {
  url: string;
  refreshedAt?: number;
}

export function feedOf(table: TableNode): FeedInfo | null {
  const f = (table.data as { $feed?: unknown }).$feed;
  return f && typeof (f as FeedInfo).url === "string" ? (f as FeedInfo) : null;
}

const rid = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Pull the source and apply it to the table. Returns a summary line. */
export async function refreshTableFeed(
  store: BoardStore,
  tableId: string,
): Promise<string> {
  const table = store.getNode(tableId);
  if (table?.type !== "table") throw new Error("no such table");
  const feed = feedOf(table);
  if (!feed) throw new Error("This table has no linked source.");

  const { text } = await api<{ text: string }>(
    "GET",
    `/fetch?url=${encodeURIComponent(feed.url)}`,
  );
  const grid = toGrid(parseDelimited(text));
  if (!grid.headers.length || !grid.rows.length) {
    throw new Error("The source didn't look like CSV/TSV with a header row.");
  }

  // Columns keep their ids when the header name matches, so per-column
  // state (widths, aggregate ops, bindings) survives a refresh.
  const oldByName = new Map(
    table.columns.map((c) => [c.name.trim().toLowerCase(), c]),
  );
  const columns = grid.headers.map((h) => {
    const old = oldByName.get(h.trim().toLowerCase());
    return old ? { ...old, name: h } : { id: rid(), name: h, w: 160 };
  });

  // Rows keep their ids when the first-column key matches (duplicates
  // pair up in order), so cell-bound stickies keep pointing at "their" row.
  const firstOldCol = table.columns[0]?.id;
  const oldIdsByKey = new Map<string, string[]>();
  if (firstOldCol) {
    for (const r of table.rows) {
      const key = (r.cells[firstOldCol] ?? "").trim();
      if (!oldIdsByKey.has(key)) oldIdsByKey.set(key, []);
      oldIdsByKey.get(key)!.push(r.id);
    }
  }
  const rows = grid.rows.map((values) => {
    const key = (values[0] ?? "").trim();
    const id = oldIdsByKey.get(key)?.shift() ?? rid();
    const cells: Record<string, string> = {};
    columns.forEach((c, i) => {
      cells[c.id] = values[i] ?? "";
    });
    return { id, cells };
  });

  store.updateNode(table.id, {
    columns,
    rows,
    h: Math.max(table.h, (rows.length + 1) * 34),
    data: { ...table.data, $feed: { url: feed.url, refreshedAt: Date.now() } },
  });
  return `${rows.length} rows, ${columns.length} columns from the source`;
}

export function linkTableFeed(store: BoardStore, tableId: string, url: string): void {
  const table = store.getNode(tableId);
  if (table?.type !== "table") return;
  store.updateNode(tableId, { data: { ...table.data, $feed: { url } } });
}

export function unlinkTableFeed(store: BoardStore, tableId: string): void {
  const table = store.getNode(tableId);
  if (table?.type !== "table") return;
  const data = { ...table.data };
  delete (data as { $feed?: unknown }).$feed;
  store.updateNode(tableId, { data });
}
