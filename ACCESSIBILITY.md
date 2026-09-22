# Orim accessibility conformance statement

Infinite canvases are historically the least accessible category of
software — most competitors expose a screen reader to nothing at all.
Orim treats accessibility as an architectural property, not a retrofit:
the board is a typed, structured graph, so it can be *rendered* as an
accessible tree, not merely described.

Target: WCAG 2.1 AA / EN 301 549 / Section 508. Status: **partial,
actively progressing** — this statement is honest by design and updated
as gaps close.

## How it works

- **The accessibility mirror**: every board is mirrored as a native ARIA
  tree in reading order — frames as expandable branches, stickies and
  shapes as items with rich labels ("Sticky note: Open file format,
  green, 3 votes, estimate 5"), tables with rows as children, connectors
  described in prose ("Connector from 'Payment confirmation' to row
  'Ship exports v2' of 'Tasks'"). The same reading-order definition
  drives Markdown export and agent reads: what you export is what a
  screen reader hears.
- **Full keyboard operation** of the tree: arrows navigate, Left/Right
  collapse and expand, Home/End jump, Enter edits text in place (a real
  contenteditable), Delete removes objects. Selection follows focus and
  the camera moves to the focused object.
- **Live announcements**: additions, removals and edits — including
  collaborators' and AI agents' — are announced via a polite live
  region.
- **Named, labelled controls**: all toolbar and dialog controls carry
  accessible names and pressed states.
- **Color is never the only signal**: palette colors pair fills with
  AA-contrast text; votes, fields and aggregates are text, not color.

## Known gaps (roadmap)

- `aria-selected` in the tree updates on rebuild, not on every canvas
  selection change.
- No visible focus ring for sighted keyboard users driving the tree.
- No reduced-motion / high-contrast modes yet.
- Canvas drag interactions (move/resize/draw) have no keyboard
  equivalent yet; creation and text editing do.
- Formal screen-reader test passes (VoiceOver/NVDA/JAWS) are pending;
  conformance so far is verified against the browser accessibility tree.

A full VPAT will be published once the formal AT test pass completes.
Accessibility feedback: accessibility@thedoidea.co.
