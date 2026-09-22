/**
 * Grid import: CSV/spreadsheet data → the right diagram, inferred.
 *
 * - a column whose values reference another column's values → org chart
 * - from/to style column pairs → dependency graph
 * - a low-cardinality status/category column → kanban (frames of stickies)
 * - anything else → a table node
 *
 * Every generated object carries its source row in `data`, so the diagram
 * stays queryable, exportable and agent-readable — not a picture.
 */
import type { Connector, Node, PaletteColor } from "@orim/schema";

// --- parsing -----------------------------------------------------------------

/** Quote-aware delimited-text parser; auto-detects , ; or tab. */
export function parseDelimited(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const counts: [string, number][] = [",", ";", "\t"].map((d) => [
    d,
    (firstLine.match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) ?? []).length,
  ]);
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0]![1] > 0 ? counts[0]![0] : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface ImportedGrid {
  headers: string[];
  rows: string[][];
}

export function toGrid(raw: string[][]): ImportedGrid {
  if (!raw.length) return { headers: [], rows: [] };
  const width = Math.max(...raw.map((r) => r.length));
  const pad = (r: string[]) => {
    const out = [...r];
    while (out.length < width) out.push("");
    return out.map((c) => c.trim());
  };
  const first = pad(raw[0]!);
  const looksLikeHeader = first.every((c) => c === "" || isNaN(Number(c)));
  if (looksLikeHeader && raw.length > 1) {
    return { headers: first, rows: raw.slice(1).map(pad) };
  }
  return {
    headers: first.map((_, i) => `Column ${i + 1}`),
    rows: raw.map(pad),
  };
}

// --- inference ---------------------------------------------------------------

export type ImportPlan =
  | { kind: "hierarchy"; idCol: number; parentCol: number; extraCol: number | null }
  | { kind: "graph"; fromCol: number; toCol: number; labelCol: number | null }
  | { kind: "kanban"; groupCol: number; labelCol: number }
  | { kind: "table" };

const col = (grid: ImportedGrid, c: number): string[] =>
  grid.rows.map((r) => r[c] ?? "");

function distinct(values: string[]): Set<string> {
  return new Set(values.filter((v) => v !== ""));
}

export function inferPlan(grid: ImportedGrid): ImportPlan {
  const n = grid.headers.length;
  const h = grid.headers.map((x) => x.toLowerCase());
  if (!grid.rows.length || n === 0) return { kind: "table" };

  // Explicit edge list: from/to style headers.
  const fromCol = h.findIndex((x) => /^(from|source|src|start|upstream|dependency)$/.test(x));
  const toCol = h.findIndex((x) => /^(to|target|dst|dest|end|downstream|dependent)$/.test(x));
  if (fromCol >= 0 && toCol >= 0 && fromCol !== toCol) {
    const labelCol = h.findIndex((x) => /^(label|type|relation|kind|via)$/.test(x));
    return { kind: "graph", fromCol, toCol, labelCol: labelCol >= 0 ? labelCol : null };
  }

  // Hierarchy: a parent-ish column whose values live in an id-ish column.
  const parentByName = h.findIndex((x) => /manager|parent|reports?[ _-]?to|boss|supervisor|lead/.test(x));
  const idCandidates = [...Array(n).keys()].filter((c) => {
    const vals = col(grid, c);
    const d = distinct(vals);
    return d.size >= Math.max(2, vals.filter((v) => v !== "").length * 0.9);
  });
  const containment = (idc: number, pc: number): number => {
    const ids = distinct(col(grid, idc));
    const parents = col(grid, pc).filter((v) => v !== "");
    if (!parents.length) return 0;
    return parents.filter((p) => ids.has(p)).length / parents.length;
  };
  const pickExtra = (idc: number, pc: number): number | null => {
    const other = [...Array(n).keys()].find((c) => c !== idc && c !== pc && col(grid, c).some((v) => v));
    return other ?? null;
  };
  if (parentByName >= 0) {
    let best = -1;
    let bestScore = 0;
    for (const idc of idCandidates) {
      if (idc === parentByName) continue;
      const score = containment(idc, parentByName);
      if (score > bestScore) {
        bestScore = score;
        best = idc;
      }
    }
    if (best >= 0 && bestScore >= 0.6) {
      return { kind: "hierarchy", idCol: best, parentCol: parentByName, extraCol: pickExtra(best, parentByName) };
    }
  }
  for (const idc of idCandidates) {
    for (let pc = 0; pc < n; pc++) {
      if (pc === idc) continue;
      const parents = col(grid, pc);
      const hasRoot = parents.some((v) => v === "");
      if (hasRoot && containment(idc, pc) >= 0.8 && distinct(parents).size > 1) {
        return { kind: "hierarchy", idCol: idc, parentCol: pc, extraCol: pickExtra(idc, pc) };
      }
    }
  }

  // Kanban: a low-cardinality grouping column.
  const groupByName = h.findIndex((x) =>
    /status|state|stage|category|priority|lane|column|phase|type|theme|bucket/.test(x),
  );
  const qualifies = (c: number): boolean => {
    const d = distinct(col(grid, c));
    return d.size >= 2 && d.size <= 6 && grid.rows.length >= d.size * 2;
  };
  let groupCol = groupByName >= 0 && qualifies(groupByName) ? groupByName : -1;
  if (groupCol < 0) {
    groupCol = [...Array(n).keys()].find(
      (c) => qualifies(c) && distinct(col(grid, c)).size <= 5 &&
        col(grid, c).every((v) => v.length <= 20),
    ) ?? -1;
  }
  if (groupCol >= 0 && n >= 2) {
    const candidates = [...Array(n).keys()].filter((c) => c !== groupCol);
    const byName = candidates.find((c) =>
      /task|name|title|item|label|product|feature|story|summary/.test(h[c]!),
    );
    const labelCol =
      byName ??
      candidates.sort((a, b) => distinct(col(grid, b)).size - distinct(col(grid, a)).size)[0] ??
      0;
    return { kind: "kanban", groupCol, labelCol };
  }

  return { kind: "table" };
}

// --- building ----------------------------------------------------------------

export interface BuiltImport {
  nodes: Node[];
  connectors: Connector[];
  /** ELK direction when the result needs auto-layout; TREE = tidy tree. */
  layout: "RIGHT" | "DOWN" | "LEFT" | "UP" | "TREE" | null;
  summary: string;
}

const GROUP_COLORS: PaletteColor[] = ["yellow", "teal", "violet", "orange", "pink", "green"];
const MAX_DIAGRAM_ROWS = 200;

interface BuildOpts {
  newId(): string;
  origin: { x: number; y: number };
  index: string;
  title?: string;
}

function rowBag(grid: ImportedGrid, row: string[]): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  grid.headers.forEach((hdr, i) => {
    if (row[i]) bag[hdr] = row[i];
  });
  return bag;
}

export function buildFromGrid(grid: ImportedGrid, plan: ImportPlan, opts: BuildOpts): BuiltImport {
  const { newId, origin, index } = opts;
  const rows = grid.rows.slice(0, plan.kind === "table" ? 500 : MAX_DIAGRAM_ROWS);
  const base = {
    parent: null, rotation: 0, index, locked: false,
  };

  if (plan.kind === "hierarchy" || plan.kind === "graph") {
    const nodes: Node[] = [];
    const connectors: Connector[] = [];
    const byLabel = new Map<string, string>();
    const ensure = (label: string, color: PaletteColor, extra?: string): string => {
      let id = byLabel.get(label);
      if (!id) {
        id = newId();
        byLabel.set(label, id);
        nodes.push({
          ...base, id, type: "shape", kind: "rect",
          x: origin.x, y: origin.y,
          w: 176, h: extra ? 72 : 56,
          data: {},
          text: extra ? `${label}\n${extra}` : label,
          color, fillStyle: "solid",
        });
      }
      return id;
    };

    if (plan.kind === "hierarchy") {
      for (const row of rows) {
        const id = row[plan.idCol];
        if (!id) continue;
        const extra = plan.extraCol !== null ? row[plan.extraCol] : undefined;
        const isRoot = !row[plan.parentCol];
        const nodeId = ensure(id, isRoot ? "violet" : "blue", extra || undefined);
        const node = nodes.find((x) => x.id === nodeId);
        if (node) node.data = rowBag(grid, row);
      }
      for (const row of rows) {
        const id = row[plan.idCol];
        const parent = row[plan.parentCol];
        if (!id || !parent || !byLabel.has(parent)) continue;
        // Reporting lines always leave the parent's bottom and enter the
        // child's top — an org chart should read strictly downward.
        connectors.push({
          id: newId(), type: "connector",
          from: { node: byLabel.get(parent)!, anchor: "s" },
          to: { node: byLabel.get(id)!, anchor: "n" },
          label: "", style: "arrow", index, data: {},
        });
      }
      return {
        nodes, connectors, layout: "TREE",
        summary: `Org chart: ${nodes.length} nodes, ${connectors.length} reporting lines`,
      };
    }

    for (const row of rows) {
      const from = row[plan.fromCol];
      const to = row[plan.toCol];
      if (!from || !to) continue;
      connectors.push({
        id: newId(), type: "connector",
        from: { node: ensure(from, "teal"), anchor: "auto" },
        to: { node: ensure(to, "blue"), anchor: "auto" },
        label: plan.labelCol !== null ? row[plan.labelCol] ?? "" : "",
        style: "arrow", index, data: rowBag(grid, row),
      });
    }
    return {
      nodes, connectors, layout: "RIGHT",
      summary: `Graph: ${nodes.length} nodes, ${connectors.length} edges`,
    };
  }

  if (plan.kind === "kanban") {
    const nodes: Node[] = [];
    const groups: string[] = [];
    const byGroup = new Map<string, string[][]>();
    for (const row of rows) {
      const g = row[plan.groupCol] || "(none)";
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        groups.push(g);
      }
      byGroup.get(g)!.push(row);
    }
    const STICKY_W = 180, STICKY_H = 120, GAP = 16, PAD = 24, TITLE = 40;
    const laneW = 2 * STICKY_W + GAP + PAD * 2;
    groups.forEach((g, gi) => {
      const members = byGroup.get(g)!;
      const rowsNeeded = Math.ceil(members.length / 2);
      const laneH = TITLE + rowsNeeded * (STICKY_H + GAP) + PAD;
      const laneX = origin.x + gi * (laneW + 40);
      const frameId = newId();
      nodes.push({
        ...base, id: frameId, type: "frame",
        x: laneX, y: origin.y, w: laneW, h: laneH, data: {},
        title: g,
      });
      members.forEach((row, i) => {
        nodes.push({
          ...base, id: newId(), type: "sticky", parent: frameId,
          x: laneX + PAD + (i % 2) * (STICKY_W + GAP),
          y: origin.y + TITLE + Math.floor(i / 2) * (STICKY_H + GAP),
          w: STICKY_W, h: STICKY_H,
          data: rowBag(grid, row),
          text: row[plan.labelCol] ?? "",
          color: GROUP_COLORS[gi % GROUP_COLORS.length]!,
        });
      });
    });
    return {
      nodes, connectors: [], layout: null,
      summary: `Kanban: ${rows.length} cards in ${groups.length} lanes (by ${grid.headers[plan.groupCol]})`,
    };
  }

  const columns = grid.headers.map((name, i) => ({ id: `c${i}`, name, w: 160 }));
  const tableRows = rows.map((row, ri) => ({
    id: `r${ri}`,
    cells: Object.fromEntries(row.map((v, i) => [`c${i}`, v] as const).filter(([, v]) => v !== "")),
  }));
  return {
    nodes: [{
      ...base, id: newId(), type: "table",
      x: origin.x, y: origin.y,
      w: Math.min(columns.length * 160, 1120), h: (tableRows.length + 1) * 34,
      data: {},
      title: opts.title ?? "Imported data",
      columns, rows: tableRows,
    }],
    connectors: [], layout: null,
    summary: `Table: ${tableRows.length} rows, ${columns.length} columns`,
  };
}
