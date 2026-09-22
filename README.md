<p align="center">
  <img src="apps/web/public/orim.svg" alt="Orim" width="140" />
</p>

<p align="center"><strong>The open, structured, agent-native visual canvas.</strong><br/>
(Yes, it's Miro backwards.)</p>

<p align="center">
  <img src="docs/hero.gif" alt="Dropping team.csv on the canvas builds a laid-out org chart" width="720" />
</p>

---

Miro, Mural and FigJam treat the canvas as a **picture**: a bag of objects whose
meaning lives only in humans' heads. Everything wrong with them follows from
that — lossy exports, trapped data, no accessibility, AI bolted on as a chatbot
in a sidebar.

Orim's bet: **the canvas is a document — a typed, structured graph that happens
to have a spatial projection.** Every feature below falls out of that one
decision.

## What works today

**Editor**
- Infinite canvas at 60fps with 10k+ objects (viewport culling + LOD), subtle
  adaptive dot grid, minimap, zoom-to-fit
- Sticky notes, shapes (rect/ellipse/diamond/pill — switchable in place),
  text, frames with containment, freehand ink, tables
- Elbow connectors with rounded joins that **route around obstacles** (A* over
  a sparse lattice), anchor to node sides via hover ports, and can bind to a
  **specific table row**
- Multi-select, marquee, resize, copy/paste/duplicate, undo/redo, full
  keyboard shortcut set

**Multiplayer & persistence**
- Real-time collaboration via Yjs CRDTs (field-level last-writer-wins) with
  presence cursors
- **Local-first**: boards live in IndexedDB and work fully offline; the sync
  server (Hocuspocus + SQLite) is an accelerator, not a requirement
- A board URL is a share link (`?b=<name>`)

**Structured data**
- Tables are first-class canvas objects: editable cells, tab-through, add
  rows/columns
- **Cell-bound stickies**: a sticky can be a live view of a table cell — edit
  either side and both update; move the sticky anywhere, the binding is data,
  not geometry
- **Cluster synthesis**: select a pile of stickies → one click turns spatial
  clusters into a structured table (frame titles become cluster names) with
  every sticky bound to its row
- Every object carries a free-form `data` bag, editable in the Data panel —
  a sticky on a blueprint can carry an SLA

**Smart fields**
- Put a number on a sticky (`estimate: 5`, `cost: 1200`) and it renders as
  a chip; put several inside a frame and the frame **computes the
  aggregate with zero config** — click the chip to cycle Σ/avg/min/max/#.
  Numeric table columns grow a totals footer. Sprint capacity, budget
  workshops and RICE scoring fall out for free, and agents can write
  fields over MCP ("estimate these 20 stickies")
- Field values flow into Markdown exports and the accessibility tree

**Import — the magic trick**
- **Drop a CSV/TSV/Excel file** on the canvas and Orim infers the right
  diagram from the data's shape:
  - a column referencing another column's values → **org chart**
  - from/to columns → **dependency graph**
  - a low-cardinality status column → **kanban lanes**
  - anything else → a table
- **Paste** works too: Mermaid flowcharts become live diagrams, Markdown
  outlines become framed sticky sections, spreadsheet cells (TSV) run the same
  inference, plain text becomes stickies
- Generated objects carry their source rows in `data` — the diagram is still
  a database

**The format is the spec**
- The board format is openly documented at [`docs/`](docs/index.html) — served
  as a static site (GitHub Pages ready), with a machine-readable
  [JSON Schema](docs/orim.schema.json) **generated from the zod source of
  truth** (`pnpm --dir packages/schema spec`), so the spec can't drift from
  the implementation

**Export — your data is never trapped**
- Markdown outline (reading order, real Markdown tables, connection lists),
  Mermaid, SVG, PNG, and the open JSON format — one click each
- The Markdown/Mermaid exports round-trip back in via paste

**Workshops**
- **Dot voting**, done right: votes are data with correct CRDT semantics
  (one entry per voter — simultaneous voting can't clobber anyone). Set a
  budget, click to vote, live badges and a countdown bar, then **rank the
  results into a bound table** in one click; vote counts flow into
  Markdown exports, the accessibility tree and MCP reads
- **Shared timer**: one click, everyone sees the same countdown, gentle
  chime at zero
- **Private drafts**: write ideas only you can see, then reveal — or have
  the facilitator broadcast "everyone reveal" and all drafts land on the
  board simultaneously (the anti-anchoring move Miro charges for)
- Cluster synthesis (above) closes the loop: draft privately → reveal →
  cluster → vote → ranked actions

**Agent-native (MCP)**
- A built-in MCP server exposes boards as structured data:
  `list_boards`, `read_board` (markdown/json/mermaid/svg), `create_objects`
  (with `$n` cross-references), `update_objects`, `delete_objects`,
  `apply_layout` (ELK layered / grid), `find_empty_space`, `synthesize_table`
- Agent edits ride the same CRDT pipeline as human edits — people watching the
  board see them appear live
- `create_objects` warns agents when new objects overlap existing content

**Accessibility — the moat**
- The board is mirrored as a native **ARIA tree** in reading order: frames as
  branches, tables with rows as children, connectors described in prose
- Full keyboard navigation; selection follows focus and the camera jumps to
  the focused object; Enter edits text in place
- A live region announces changes — including collaborator and agent edits
  arriving over sync

**Auto-layout**
- ELK layered layout for connected graphs, grid packing for loose stickies,
  empty-space finding — available in the editor pipeline and over MCP

## Self-hosted by design

Orim is built for teams that can't put their thinking in someone else's
cloud — government, finance, healthcare, defense. **One container, one
port, one SQLite file**; zero external calls, air-gap ready; OIDC SSO
against your IdP; an append-only audit log with an admin console
(`/admin`) for users, roles, sessions and audit browsing; and an open,
audited format.

```bash
docker compose up -d        # → http://localhost:1234
```

See [DEPLOY.md](DEPLOY.md), [SECURITY.md](SECURITY.md) and
[ACCESSIBILITY.md](ACCESSIBILITY.md).

## Developing

Requires Node ≥ 22.5 (the sync server uses built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm --dir apps/sync dev    # ws://localhost:1234 — boards persist to apps/sync/.data
pnpm --dir apps/web dev     # http://localhost:5181
```

Open two tabs on the same board to see multiplayer. Drag anything from
[`samples/`](samples/) onto the canvas — `team.csv` becomes an org chart under
your cursor.

### MCP

[`.mcp.json`](.mcp.json) registers the server for Claude Code automatically.
For other MCP clients:

```json
{
  "mcpServers": {
    "orim": {
      "command": "node",
      "args": ["--import", "tsx", "apps/mcp/src/server.ts"]
    }
  }
}
```

Then ask your agent to "add a SWOT template to the main board" and watch it
happen live.

## Keyboard

| | |
|---|---|
| `V` select · `H` hand | `N` sticky · `T` text · `F` frame |
| `R`/`O`/`D` shapes · `G` table | `C` connector · `P` pen |
| `⌘Z`/`⇧⌘Z` undo/redo | `⌘C`/`⌘V`/`⌘D` copy/paste/duplicate |
| `1` zoom to fit · `0` reset zoom | `\` data panel |
| Double-click | quick sticky / edit text / rename |

## Architecture

```
apps/web      the editor (Vite + canvas renderer + ProseMirror overlays)
apps/sync     Hocuspocus WebSocket sync server, SQLite persistence
apps/mcp      MCP server (stdio) — boards as structured data for agents
apps/spike    Phase 0 perf spike, kept for benchmarking

packages/schema     the Orim file format: typed nodes/connectors, zod, versioned
packages/store      Yjs-backed board state, field-level LWW, undo
packages/editor     tools, selection, geometry, obstacle-avoiding routing
packages/renderer   Canvas2D renderer: culling, LOD, grid, ports, tables
packages/convert    exports (md/mermaid/svg/json) + import inference (csv/xlsx/
                    mermaid/markdown) sharing one reading-order pass
packages/layout     ELK layered layout, grid packing, empty-space finding,
                    cluster synthesis
```

The reading order that drives Markdown export, the Data panel and the
accessibility tree is **one definition** (`orderBoard`) — what you export is
what a screen reader hears is what an agent reads.

## Status

Early and moving fast — see [PLAN.md](PLAN.md) for the full thesis, roadmap
and honest gap list (comments/roles, format spec site, per-cell CRDT for
tables, VoiceOver audit). Sample data and the import-inference regression
check live in [`samples/`](samples/).

License: the board format, schema and all converters are **MIT**; the
application is source-available under **FSL-1.1-MIT** (each release
becomes MIT after two years). Viewing, commenting and exporting your own
data are never gated. Details in [LICENSING.md](LICENSING.md).
