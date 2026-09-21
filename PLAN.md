# Orim — Plan

*The open, structured, agent-native visual canvas. (Yes, the name is Miro backwards.)*

Last updated: 2026-09-21

---

## 1. Thesis

Miro, Mural, and FigJam all treat the canvas as a **picture**: a bag of pixels-ish objects
whose meaning lives only in humans' heads. Everything wrong with them follows from that:
you can't get your data out in a useful form, screen readers can't read it, AI can't
operate on it semantically, exports are lossy screenshots, and the vendor owns your work.

Orim's bet: **the canvas is a document — a typed, structured graph that happens to have a
spatial projection.** Every differentiator falls out of that one decision:

| Incumbent pain | Orim answer |
|---|---|
| Walled garden, vendor lock-in | Open, versioned JSON file format; self-hostable sync server; local-first (boards work offline, sync when connected) |
| Data trapped inside | Everything round-trips: JSON, Markdown, Mermaid, CSV, SVG, PNG, PDF. A retro board exports as a readable doc, not a screenshot |
| No structure — can't turn data into diagrams | Objects carry typed data (a sticky is `{text, author, votes, tags}`); paste CSV/Markdown/Mermaid/a transcript and get real board objects; auto-layout (ELK/dagre) built in |
| Horrible typography | Real type system: variable fonts, optical sizing, a small set of great curated typefaces, proper text layout, styles that cascade like a design tool, not Comic-Sans-adjacent defaults |
| Inaccessible (infinite canvas ≈ a11y dead zone) | Semantic accessibility tree mirroring the scene graph, keyboard-first spatial navigation, screen-reader narration of structure ("frame 'Q3 Goals', 12 stickies, 3 clusters"), WCAG AA contrast enforced in the palette |
| No native MCP / AI is bolted on | First-class MCP server from day one: agents read and write boards as structured data ("cluster these stickies by theme", "turn this transcript into a journey map"). The board is context, not a picture |
| No/bad export, no API | Export is a core feature, not an upsell. Public API + webhooks. The file format spec is published |
| Per-seat pricing punishes viewers | Viewers/commenters free forever; charge for editors and hosted sync |
| Sluggish on big boards | Performance budget from day one: 60fps pan/zoom at 10k objects (culling + tiled rendering), renderer abstracted so we can move hot paths to WebGL/WebGPU |

**Positioning:** "Obsidian/Excalidraw energy with Figma-level craft" — for software teams,
facilitators, and AI-forward teams who are tired of their thinking being held hostage.

---

## 2. Build vs. buy: the canvas engine

The three realistic options, evaluated against the thesis:

- **tldraw SDK** — best-in-class editor ergonomics, but as of SDK 4.0 (Sept 2025) production
  use requires a ~$6k/yr commercial license or a watermark, and we'd be building "the open
  alternative to walled gardens" on someone else's licensed engine and document model.
  Strategically incoherent for us. **No.**
- **Fork/embed Excalidraw** — genuinely MIT, proven (Notion's whiteboard is built on it),
  but its document model is a flat array of drawing elements. Our entire differentiation
  (typed objects, semantic tree, structured import/export, a11y mirror) lives at the
  document-model layer, so we'd be fighting the fork forever. Fine to **mine it for
  reference code** (their rough-shape rendering, selection UX), not to build on.
- **Own document model + own editor, leaning hard on best-of-breed libraries** — more
  upfront work, but the document model *is* the product. **This is the plan.**

We don't build from zero. We assemble:

| Concern | Library |
|---|---|
| CRDT / sync / offline / undo | **Yjs** (ecosystem winner; per-object last-writer-wins maps — a whiteboard doesn't need text-CRDT complexity except inside text nodes, where Yjs also excels) |
| Sync server | **Hocuspocus** or **y-sweet** — self-hostable Node/Rust service we also run as the hosted offering. Presence via Yjs awareness |
| Rich text in nodes | **ProseMirror** (or Lexical) mounted as DOM overlay on the canvas — also our a11y and IME win |
| Freehand ink | **perfect-freehand** |
| Auto-layout | **elkjs** / **dagre** |
| Rendering | Custom Canvas2D renderer with viewport culling + LOD; renderer behind an interface so WebGL/WebGPU (PixiJS or custom) can replace it when profiling demands |
| Text→diagram | Mermaid parser for import/export + LLM structured output for fuzzy input |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────┐
│ apps/web (Next.js, Vercel)                             │
│   dashboard, auth, sharing, billing, board shell       │
│                                                        │
│   @orim/editor    tools, selection, keyboard model     │
│   @orim/renderer  canvas draw loop, culling, LOD       │
│   @orim/a11y      semantic DOM mirror of scene graph   │
│   @orim/store     Yjs doc ↔ typed scene graph, undo    │
│   @orim/schema    the file format: types + zod + docs  │
│   @orim/convert   md/mermaid/csv/svg/pdf import-export │
├────────────────────────────────────────────────────────┤
│ apps/sync   Hocuspocus WS server (Fly/Railway/self-    │
│             host; NOT Vercel — long-lived WebSockets)  │
│ apps/mcp    MCP server exposing board read/write tools │
│ Postgres (metadata, permissions) + blob store          │
│             (board snapshots, images, exports)         │
└────────────────────────────────────────────────────────┘
```

Key decisions baked in:

- **`@orim/schema` is the crown jewel.** Versioned, documented, published. Every object is
  a typed node (`sticky`, `shape`, `frame`, `connector`, `table`, `embed`, `ink`, `text`)
  with a `data` bag; frames/groups give the graph hierarchy; connectors are first-class
  edges (so a board is also a graph you can query). Migrations are part of the spec.
- **Local-first:** Yjs doc persisted to IndexedDB; the app is fully functional offline and
  the sync server is an accelerator, not a requirement. This is also the anti-lock-in story:
  your boards are literally on your machine.
- **The a11y mirror:** a hidden, ordered DOM tree generated from the scene graph (reading
  order = frame hierarchy + spatial sort). Focus in the tree moves the canvas camera;
  arrow keys navigate siblings/children; every mutation is announced. Nobody has done this
  properly on an infinite canvas — it's a moat and a headline.
- **MCP server ships in v1**, not as a later integration: `list_boards`, `read_board`
  (as structured JSON *or* as Markdown outline), `create_objects`, `update_objects`,
  `apply_layout`, `export`. Same internal API powers our own AI features, keeping us honest.

---

## 4. Roadmap

**Phase 0 — Spikes (1–2 weeks).** Prove the risky bits before committing: (a) Canvas2D
renderer at 10k rects with culling at 60fps; (b) Yjs per-shape LWW sync between two tabs
with presence cursors; (c) ProseMirror overlay that stays glued to a canvas shape through
pan/zoom. Kill or confirm architecture choices here.

> ✅ **Done 2026-09-21** (`apps/spike`, run `pnpm --dir apps/sync dev` + `pnpm --dir apps/spike dev`):
> (a) 60fps sustained pan with 10,001 stickies — culled at zoom 100%, *and* with all
> 10,001 visible at 2% zoom via LOD flat-rect path. Seeding 10k in one Yjs transaction
> blocks ~1s — fine for a spike, batch/worker later. (b) Hocuspocus round-trip works:
> create in tab A appears in tab B, field update in B appears in A, presence cursors
> render. In-memory server only — doc drops when all clients disconnect (persistence is
> Phase 2, as planned). (c) ProseMirror overlay tracks its node through pan and through
> zoom (tested at 400%), 59fps while zooming with the editor open. Architecture confirmed.

**Phase 1 — Core editor (4–6 weeks).** Infinite canvas (pan/zoom/minimap), sticky notes,
shapes, connectors with anchoring, frames, freehand ink, text, selection/multi-select/
transform, copy/paste/duplicate, undo-redo (Yjs UndoManager), keyboard shortcuts throughout,
IndexedDB persistence. Exit criteria: dogfood-usable solo tool.

**Phase 2 — Multiplayer + accounts (3–4 weeks).** Hocuspocus sync, presence (cursors,
selections, viewports, follow-mode), auth, board dashboard, share links with roles
(view/comment/edit), comments. Exit criteria: run a real retro with outsiders.

**Phase 3 — The differentiators (5–6 weeks, some parallel).**
- Export suite: JSON, SVG, PNG, PDF, Markdown outline, Mermaid for diagram-shaped content.
- Import: Markdown → stickies/outline, CSV → table/grid, Mermaid → diagram, images.
- MCP server + "AI on board" features built on it (cluster, summarize, transcript → diagram).
- Typography system + theming.
- A11y mirror + keyboard spatial nav; screen-reader audit.
- Auto-layout (tidy tree, grid, cluster).

**Phase 4 — Launch (3–4 weeks).** File format spec site, self-host docs (docker compose:
sync + postgres), templates, performance hardening pass, pricing/billing, landing page.
Launch narrative: *"Your whiteboard is a database wearing a canvas. Also, it's yours."*
Ship the MCP server to the registries; open-source at minimum `@orim/schema` + `@orim/convert`
(decide later whether editor core goes source-available or MIT).

**Deliberately post-v1:** native apps, voice/video (embed via integration instead), Miro
importer (high leverage, do early in post-launch), plugin/widget SDK, org SSO/SCIM.

---

## 5. Business model (sketch)

- **Free:** unlimited boards local-first, 3 hosted multiplayer boards, unlimited viewers.
- **Pro (~$10/editor/mo):** unlimited hosted boards, version history, exports at scale.
- **Team (~$16/editor/mo):** SSO, permissions, admin, audit.
- **Self-host:** free for the core; paid enterprise support/license.
- Never charge for: viewing, commenting, exporting your own data. That's the brand.

## 6. Risks

1. **Scope trap.** Canvas editors are deceptively deep (selection math, connector routing,
   text layout, touch, IME). Mitigation: Phase 0 spikes, ruthless v1 cut list, steal
   solved patterns from Excalidraw/tldraw source as reference.
2. **"Open + AI" alone doesn't move teams off Miro.** Mitigation: local-first single-player
   excellence first (Excalidraw's adoption path), Miro importer soon after launch.
3. **tldraw or Miro ships MCP/exports.** Likely eventually — but they can't ship the open
   format or self-hosting without breaking their business model. Speed + positioning.
4. **Perf on low-end hardware.** Budget enforced in CI (render benchmark on the 10k-object
   board) from Phase 1, not retrofitted.

## 7. Immediate next steps

1. `git init`, pnpm + Turborepo monorepo scaffold, CI.
2. Draft `@orim/schema` v0 (the node/edge type system) — everything else depends on it.
3. Run the three Phase 0 spikes.
4. Name check: trademark/domain search for "Orim".
