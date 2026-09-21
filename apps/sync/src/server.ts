/**
 * Orim sync server — Hocuspocus WebSocket relay for Yjs docs.
 * Persists every board to SQLite (Node's built-in node:sqlite), so boards
 * survive server restarts. Auth and per-board permissions come later.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";

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

const server = new Server({
  port,
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
