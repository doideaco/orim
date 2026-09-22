// Regression check for the Miro importer: a fixture in Miro REST API v2
// shape must map to the expected Orim objects.
// Run from packages/convert:  node --import tsx scripts/check-miro.mjs
import { miroToBoard, stripHtml, hexToPalette } from "../src/index.ts";

const items = [
  { id: "f1", type: "frame", position: { x: 0, y: 0 }, geometry: { width: 800, height: 600 }, data: { title: "Ideas" } },
  { id: "s1", type: "sticky_note", position: { x: 100, y: 50, relativeTo: "parent_top_left" }, parent: { id: "f1" }, geometry: { width: 200, height: 200 }, data: { content: "<p>Ship it</p><p>soon</p>" }, style: { fillColor: "light_green" } },
  { id: "s2", type: "sticky_note", position: { x: 900, y: 0 }, geometry: { width: 200, height: 200 }, data: { content: "Loose &amp; free" }, style: { fillColor: "violet" } },
  { id: "sh1", type: "shape", position: { x: 1200, y: 0 }, geometry: { width: 180, height: 90 }, data: { shape: "rhombus", content: "Decision?" }, style: { fillColor: "#2d9bf0" } },
  { id: "t1", type: "text", position: { x: 0, y: -400 }, geometry: { width: 300, height: 40 }, data: { content: "<b>Q3 planning</b>" }, style: { fontSize: "24" } },
  { id: "c1", type: "card", position: { x: 1200, y: 300 }, geometry: { width: 220, height: 110 }, data: { title: "Fix login", description: "OIDC edge case" } },
  { id: "e1", type: "embed", position: { x: 0, y: 600 }, geometry: { width: 640, height: 400 }, data: { url: "https://example.com" } },
  { id: "i1", type: "image", position: { x: 700, y: 600 }, geometry: { width: 320, height: 200 }, data: { title: "Whiteboard photo" } },
  { id: "w1", type: "mindmap_node", position: { x: 0, y: 0 } },
];
const connectors = [
  { id: "l1", startItem: { id: "s1" }, endItem: { id: "sh1" }, captions: [{ content: "<p>then</p>" }] },
  { id: "l2", startItem: { id: "s1" }, endItem: { id: "missing" } },
];

let counter = 0;
const result = miroToBoard(items, connectors, { newId: () => `n${counter++}`, index: "a0" });

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);

const byType = {};
for (const n of result.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
JSON.stringify(byType) === JSON.stringify({ frame: 1, sticky: 3, shape: 2, text: 1, embed: 1 })
  ? ok(`types map: ${JSON.stringify(byType)} (card→sticky, image→placeholder shape)`)
  : fail(`unexpected type map ${JSON.stringify(byType)}`);

const framed = result.nodes.find((n) => n.type === "sticky" && n.text.startsWith("Ship it"));
const frame = result.nodes.find((n) => n.type === "frame");
framed?.parent === frame?.id ? ok("frame child keeps its parent") : fail("frame membership lost");
// child center (100,50) relative to parent top-left (-400,-300) → top-left (-500+100-100, -300+50-100)
framed && framed.x === -400 + 100 - 100 && framed.y === -300 + 50 - 100
  ? ok("parent-relative position converts to world top-left")
  : fail(`child position wrong: ${framed?.x},${framed?.y}`);

framed?.text === "Ship it\nsoon" ? ok("HTML paragraphs become lines") : fail(`text: ${JSON.stringify(framed?.text)}`);
result.nodes.some((n) => "text" in n && n.text === "Loose & free") ? ok("entities decode") : fail("entity decode");

const diamond = result.nodes.find((n) => n.type === "shape" && n.kind === "diamond");
diamond && diamond.color === "blue" ? ok("rhombus → diamond, hex #2d9bf0 → blue") : fail("shape mapping");

result.connectors.length === 1 && result.connectors[0].label === "then"
  ? ok("connector maps with caption; dangling one skipped")
  : fail(`connectors: ${JSON.stringify(result.connectors)}`);
result.skipped.mindmap_node === 1 && result.skipped.connector === 1
  ? ok(`skips are honest: ${JSON.stringify(result.skipped)}`)
  : fail(`skipped: ${JSON.stringify(result.skipped)}`);

stripHtml("<p>a</p><p>b</p>") === "a\nb" || fail("stripHtml paragraphs");
hexToPalette("#ff0000") === "red" && hexToPalette("#cccccc") === "gray" || fail("hexToPalette");
console.log(process.exitCode ? "FAILED" : "all good");
