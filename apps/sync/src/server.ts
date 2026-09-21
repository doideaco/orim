/**
 * Orim sync server — Hocuspocus WebSocket relay for Yjs docs.
 * Spike version: in-memory only. Persistence (Postgres/blob snapshots),
 * auth, and per-board rooms come in Phase 2.
 */
import { Server } from "@hocuspocus/server";

const port = Number(process.env.PORT ?? 1234);

const server = new Server({
  port,
  async onConnect({ documentName }) {
    console.log(`[orim-sync] connect: ${documentName}`);
  },
});

server.listen().then(() => {
  console.log(`[orim-sync] listening on ws://localhost:${port}`);
});
