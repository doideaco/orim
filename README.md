# Orim

The open, structured, agent-native visual canvas. See [PLAN.md](PLAN.md) for the full plan.

## Layout

- `packages/schema` — the Orim file format: typed nodes/connectors, zod-validated, versioned.
- `packages/store` — Yjs-backed board state with field-level LWW and an incremental cache.
- `apps/sync` — Hocuspocus WebSocket sync server (in-memory for now).
- `apps/spike` — Phase 0 spike app: renderer perf, multiplayer, text-overlay glue.

## Run the spike

```bash
pnpm install
pnpm --dir apps/sync dev    # ws://localhost:1234
pnpm --dir apps/spike dev   # http://localhost:5180
```

Open two browser tabs at `localhost:5180` to see multiplayer. Double-click to create a
sticky, double-click a sticky to edit, wheel to pan, ⌘/ctrl+wheel to zoom, "Seed 10k"
to stress the renderer.
