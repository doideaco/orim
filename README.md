# Orim

The open, structured, agent-native visual canvas. See [PLAN.md](PLAN.md) for the full plan.

## Layout

- `packages/schema` — the Orim file format: typed nodes/connectors, zod-validated, versioned.
- `packages/store` — Yjs-backed board state with field-level LWW and an incremental cache.
- `apps/sync` — Hocuspocus WebSocket sync server (in-memory for now).
- `apps/spike` — Phase 0 spike app: renderer perf, multiplayer, text-overlay glue.

- `apps/web` — the editor app (toolbar, shortcuts, minimap, offline persistence).
- `apps/mcp` — MCP server: agents read boards as Markdown/JSON/Mermaid/SVG and
  write typed objects back through live sync (`.mcp.json` registers it for
  Claude Code; smoke test in `apps/mcp/scripts/smoke.ts`).

## Run

Requires Node ≥ 22.5 (the sync server uses built-in `node:sqlite`).

```bash
pnpm install
pnpm --dir apps/sync dev    # ws://localhost:1234, boards persisted to apps/sync/.data
pnpm --dir apps/web dev     # http://localhost:5181
```

Open two browser tabs at `localhost:5181` to see multiplayer; `?b=<name>` in the URL
picks a board, so a link is a share link. Boards also live in IndexedDB, so the app
works fully offline and re-syncs when the server is back.

Tools: V select · H hand · N sticky · R/O/D shapes · T text · F frame · C connector ·
P pen. ⌘Z undo, ⌘C/⌘V/⌘D copy/paste/duplicate, 1 zoom-to-fit, 0 reset zoom.
`apps/spike` (port 5180) is the original Phase 0 spike, kept for perf benchmarking.
