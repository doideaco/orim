/**
 * Board access for the MCP server. Each board is opened as a live
 * Hocuspocus client, so agent edits flow through the same CRDT pipeline
 * as human edits — connected browsers see them appear in real time.
 */
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { BoardStore } from "@orim/store";
import type { ExportBoard } from "@orim/convert";

const SYNC_URL = process.env.ORIM_SYNC_URL ?? "ws://localhost:1234";
const PREFIX = "orim-"; // doc names are namespaced; tools use the bare name

interface OpenBoard {
  store: BoardStore;
  provider: HocuspocusProvider;
}

const open = new Map<string, Promise<OpenBoard>>();

export function docName(board: string): string {
  return board.startsWith(PREFIX) ? board : PREFIX + board;
}

export async function openBoard(board: string): Promise<OpenBoard> {
  const name = docName(board);
  let pending = open.get(name);
  if (!pending) {
    pending = connect(name);
    open.set(name, pending);
    pending.catch(() => open.delete(name));
  }
  return pending;
}

let socket: HocuspocusProviderWebsocket | null = null;
function sharedSocket(): HocuspocusProviderWebsocket {
  socket ??= new HocuspocusProviderWebsocket({
    url: SYNC_URL,
    WebSocketPolyfill: WebSocket,
  });
  return socket;
}

async function connect(name: string): Promise<OpenBoard> {
  const document = new Y.Doc();
  const store = new BoardStore(document);
  let markSynced!: () => void;
  const synced = new Promise<void>((resolve) => (markSynced = resolve));
  const provider = new HocuspocusProvider({
    websocketProvider: sharedSocket(),
    name,
    document,
    token: process.env.ORIM_TOKEN ?? "guest",
    onSynced: () => markSynced(),
  });
  // With an explicit websocketProvider, v4 requires attaching manually.
  provider.attach();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Could not sync "${name}" from ${SYNC_URL} — is the Orim sync server running?`)),
      6000,
    ),
  );
  if (!provider.isSynced) await Promise.race([synced, timeout]);
  return { store, provider };
}

export function toExportBoard(store: BoardStore, title: string): ExportBoard {
  return {
    title,
    nodes: [...store.nodes.values()],
    connectors: [...store.connectors.values()],
    comments: [...store.comments.values()],
    votes: Object.fromEntries(store.voteTotals()),
  };
}

/** Give the sync server a beat to fan out before a short-lived call returns. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));
