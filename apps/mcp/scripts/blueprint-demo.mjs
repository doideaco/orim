// Pressure test: build a full service blueprint (order-ahead coffee shop)
// through the MCP server — lanes as frames, stages as columns, cross-lane
// connectors for the lines of interaction/visibility, and a legend placed
// via find_empty_space. Run with the sync server up.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", new URL("../src/server.ts", import.meta.url).pathname],
});
const client = new Client({ name: "blueprint-demo", version: "0" });
await client.connect(transport);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

const BOARD = "blueprint";

// --- geometry ---------------------------------------------------------------
const STICKY_W = 220, STICKY_H = 110;
const COL_X = (col) => 50 + col * 280; // 5 stage columns
const LANE_H = 210, LANE_GAP = 60, LANE_W = 50 + 5 * 280 + 10;
const LANE_Y = (row) => row * (LANE_H + LANE_GAP);
const IN_LANE_Y = (row) => LANE_Y(row) + 55;

const lanes = [
  { title: "Physical evidence", color: "gray" },
  { title: "Customer actions", color: "yellow" },
  { title: "Frontstage", color: "teal" },
  { title: "Backstage", color: "blue" },
  { title: "Support processes", color: "violet" },
];

// [lane][stage] — null leaves the cell empty
const cells = [
  ["App Store listing", "Menu & checkout UI", "Order status screen", "Signage & counter", "Thank-you email"],
  ["Finds & installs app", "Browses menu,\nplaces order", "Tracks order status", "Picks up coffee", "Rates & reorders"],
  ["Onboarding flow", "Payment confirmation", "Push: “order ready”", "Barista greets,\nhands over order", "Loyalty points\nawarded"],
  [null, "Order routed to\nshop queue", "Barista prepares\ndrink", "Order marked\ncomplete", "Feedback logged"],
  ["App platform & CDN", "Payment processor", "Inventory system", "POS system", "CRM & loyalty\nengine"],
];

const nodes = [];
const ref = new Map(); // cell text -> $index
lanes.forEach((lane, row) => {
  nodes.push({ type: "frame", x: 0, y: LANE_Y(row), w: LANE_W, h: LANE_H, title: lane.title });
});
lanes.forEach((lane, row) => {
  cells[row].forEach((text, col) => {
    if (!text) return;
    ref.set(text, `$${nodes.length}`);
    nodes.push({
      type: "sticky", text, color: lane.color, parent: `$${row}`,
      x: COL_X(col), y: IN_LANE_Y(row), w: STICKY_W, h: STICKY_H,
    });
  });
});

const edge = (a, b, label, style = "arrow") => ({ from: ref.get(a), to: ref.get(b), label, style });
const connectors = [
  // Customer journey (left to right)
  edge("Finds & installs app", "Browses menu,\nplaces order", ""),
  edge("Browses menu,\nplaces order", "Tracks order status", ""),
  edge("Tracks order status", "Picks up coffee", ""),
  edge("Picks up coffee", "Rates & reorders", ""),
  // Line of interaction (customer ↔ frontstage)
  edge("Browses menu,\nplaces order", "Payment confirmation", "interaction"),
  edge("Push: “order ready”", "Tracks order status", ""),
  edge("Barista greets,\nhands over order", "Picks up coffee", ""),
  // Line of visibility (frontstage ↔ backstage)
  edge("Payment confirmation", "Order routed to\nshop queue", "visibility"),
  edge("Order routed to\nshop queue", "Barista prepares\ndrink", ""),
  edge("Barista prepares\ndrink", "Push: “order ready”", ""),
  edge("Order marked\ncomplete", "Loyalty points\nawarded", ""),
  // Line of internal interaction (backstage ↔ support)
  edge("Payment processor", "Payment confirmation", "internal"),
  edge("Inventory system", "Barista prepares\ndrink", ""),
  edge("POS system", "Order marked\ncomplete", ""),
  edge("Feedback logged", "CRM & loyalty\nengine", ""),
];

console.log("== building blueprint ==");
const created = await call("create_objects", { board: BOARD, nodes, connectors });
const warnings = created.split("\n").filter((l) => l.startsWith("WARNING"));
console.log(`created ${nodes.length} nodes, ${connectors.length} connectors, ${warnings.length} overlap warnings`);
warnings.slice(0, 3).forEach((w) => console.log(w));

console.log("\n== find_empty_space for legend ==");
const spot = await call("find_empty_space", { board: BOARD, w: 420, h: 200 });
console.log(spot);
const [, lx, ly] = /x=(-?\d+), y=(-?\d+)/.exec(spot).map(Number);
await call("create_objects", {
  board: BOARD,
  nodes: [
    { type: "frame", x: lx, y: ly, w: 420, h: 200, title: "How to read this" },
    { type: "text", x: lx + 20, y: ly + 30, w: 380, h: 150, parent: "$0",
      text: "Each lane is a layer of the service.\nVertical arrows cross the lines of\ninteraction, visibility and internal\ninteraction. Columns follow the\ncustomer journey left to right." },
  ],
});

console.log("\n== markdown export ==\n");
console.log(await call("read_board", { board: BOARD }));
await client.close();
process.exit(0);
