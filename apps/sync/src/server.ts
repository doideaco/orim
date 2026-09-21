/**
 * Orim sync server — Hocuspocus WebSocket relay for Yjs docs.
 * Persists every board to SQLite (Node's built-in node:sqlite), so boards
 * survive server restarts. Auth and per-board permissions come later.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import * as Y from "yjs";

const port = Number(process.env.PORT ?? 1234);
const dataDir = process.env.ORIM_DATA_DIR ?? new URL("../.data", import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(`${dataDir}/boards.db`);
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    name TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
const selectStmt = db.prepare("SELECT state FROM boards WHERE name = ?");
const upsertStmt = db.prepare(`
  INSERT INTO boards (name, state, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
`);

/** Compact preview of a board's contents for the start page gallery. */
function previewOf(state: Uint8Array): { count: number; nodes: unknown[] } {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const nodes = [...doc.getMap("nodes").values()]
      .map((n) => (n as Y.Map<unknown>).toJSON() as Record<string, unknown>)
      .filter((n) => typeof n.x === "number");
    return {
      count: nodes.length,
      nodes: nodes.slice(0, 150).map((n) => ({
        x: n.x, y: n.y, w: n.w, h: n.h, type: n.type, color: n.color ?? null,
      })),
    };
  } catch {
    return { count: 0, nodes: [] };
  }
}

const server = new Server({
  port,
  // Minimal HTTP API for the start page. CORS-open: this is a local tool.
  async onRequest({ request, response }) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      });
      response.end(JSON.stringify(body));
      // Hocuspocus contract: an EMPTY rejection short-circuits later hooks
      // and the default handler; a rejection carrying an error is rethrown.
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject();
    };
    if (request.method === "OPTIONS" && url.pathname.startsWith("/boards")) {
      return send(204, {});
    }
    if (request.method === "GET" && url.pathname === "/boards") {
      const rows = db
        .prepare("SELECT name, state, updated_at FROM boards ORDER BY updated_at DESC")
        .all() as { name: string; state: Uint8Array; updated_at: number }[];
      return send(200, rows.map((r) => ({
        name: r.name.replace(/^orim-/, ""),
        updatedAt: r.updated_at,
        ...previewOf(new Uint8Array(r.state)),
      })));
    }
    if (request.method === "DELETE" && url.pathname === "/boards") {
      const name = url.searchParams.get("name");
      if (!name) return send(400, { error: "name required" });
      db.prepare("DELETE FROM boards WHERE name = ?").run(`orim-${name}`);
      return send(200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/boards/rename") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to) return send(400, { error: "from and to required" });
      const exists = selectStmt.get(`orim-${to}`);
      if (exists) return send(409, { error: "target exists" });
      db.prepare("UPDATE boards SET name = ? WHERE name = ?").run(`orim-${to}`, `orim-${from}`);
      return send(200, { ok: true });
    }
    return Promise.resolve();
  },
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const row = selectStmt.get(documentName) as { state: Uint8Array } | undefined;
        return row ? new Uint8Array(row.state) : null;
      },
      store: async ({ documentName, state }) => {
        upsertStmt.run(documentName, state, Date.now());
      },
    }),
  ],
  async onConnect({ documentName }) {
    console.log(`[orim-sync] connect: ${documentName}`);
  },
});

server.listen().then(() => {
  console.log(`[orim-sync] listening on ws://localhost:${port}, data in ${dataDir}`);
});
