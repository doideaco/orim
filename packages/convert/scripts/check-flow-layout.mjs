// Regression check: a pasted Mermaid flowchart with return loops, edge
// labels, and an anti-parallel pair must come out readable — the forward
// flow ranks strictly down the page (back-edges never promote a mid-flow
// node to the top), nothing overlaps, and opposite-direction twins route
// as two separate lines. Run from packages/convert:
//   node --import tsx scripts/check-flow-layout.mjs
import { buildFromMermaid } from "../src/import-text.ts";
import { layered } from "@orim/layout";
import { routeConnector } from "@orim/editor";

// The shape that uncovered the failures: a reading loop with two
// back-edges, a decision diamond, labelled edges, a bar <-> away pair,
// and — crucially — a node (`first`) referenced lines before it is
// defined, which fools any model-order cycle breaking into reversing
// the forward edge that reaches it.
const MERMAID = `flowchart TD
  start((Start)) --> brief[Brief]
  search[Search card] -->|Watch this game| first
  brief -->|open a story| reader[Reader]
  reader --> panel[Side panel]
  panel -->|pick the lightest page| reader
  panel --> follow{Follow this?}
  follow -->|keep reading| brief
  follow -->|Tap Watch| first(First watch)
  first --> away[Back to browsing]
  away -->|confirmed update| bar[Watch bar]
  bar --> away
  bar -->|full time| wrap(Wrap-up)
  wrap --> ends((End))`;

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failed++;
};

let seq = 0;
const built = buildFromMermaid(MERMAID, {
  newId: () => `n${seq++}`,
  origin: { x: 0, y: 0 },
  index: "a0",
});
const positions = await layered(built.nodes, built.connectors, {
  direction: "DOWN",
  spacing: 40,
});
for (const n of built.nodes) Object.assign(n, positions.get(n.id));

const at = (text) => built.nodes.find((n) => n.text === text);

// Forward flow ranks strictly down the page despite the cycles.
const order = [
  "Start", "Brief", "Reader", "Side panel", "Follow this?",
  "First watch", "Back to browsing", "Watch bar", "Wrap-up", "End",
];
for (let i = 1; i < order.length; i++) {
  check(
    at(order[i]).y > at(order[i - 1]).y,
    `${order[i]} ranks below ${order[i - 1]}`,
  );
}

// No two nodes may land on top of each other.
let overlaps = 0;
for (let i = 0; i < built.nodes.length; i++) {
  for (let j = i + 1; j < built.nodes.length; j++) {
    const a = built.nodes[i];
    const b = built.nodes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
  }
}
check(overlaps === 0, "no two nodes overlap");

// The away <-> bar pair must route as two separate lines, not one.
const getNode = (id) => built.nodes.find((n) => n.id === id);
const awayId = at("Back to browsing").id;
const barId = at("Watch bar").id;
const pair = built.connectors.filter(
  (c) =>
    (c.from.node === awayId && c.to.node === barId) ||
    (c.from.node === barId && c.to.node === awayId),
);
check(pair.length === 2, "anti-parallel pair present in fixture");
const [r1, r2] = pair.map((c) =>
  routeConnector(c, getNode, built.nodes, built.connectors),
);
const mid = (r) => r[Math.floor(r.length / 2)];
const apart = Math.hypot(mid(r1).x - mid(r2).x, mid(r1).y - mid(r2).y);
check(apart >= 12, `anti-parallel twins separate (${apart.toFixed(1)}px apart mid-route)`);

process.exit(failed ? 1 : 0);
