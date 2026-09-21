// apply_layout demo: build a deliberately messy dependency graph, then
// let ELK untangle it. Run with sync server up.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", new URL("../src/server.ts", import.meta.url).pathname],
});
const client = new Client({ name: "layout-demo", version: "0" });
await client.connect(transport);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

const steps = [
  "auth service", "api gateway", "user db", "billing", "email worker",
  "webhooks", "frontend", "analytics",
];
// Messy on purpose: everything piled around the origin.
const out = await call("create_objects", {
  board: "flow",
  nodes: steps.map((text, i) => ({
    type: "shape", kind: i === 0 ? "pill" : "rect",
    x: (i * 37) % 160, y: (i * 53) % 140, w: 170, h: 70,
    text, color: ["blue", "teal", "violet", "orange"][i % 4],
  })),
  connectors: [
    { from: "$6", to: "$1", label: "https" },
    { from: "$1", to: "$0" },
    { from: "$0", to: "$2" },
    { from: "$1", to: "$3" },
    { from: "$3", to: "$4", label: "receipts" },
    { from: "$3", to: "$5" },
    { from: "$1", to: "$7" },
    { from: "$6", to: "$7", label: "events" },
  ],
});
console.log(out.split("\n").filter((l) => l.startsWith("WARNING")).length + " overlap warnings (expected — it's a pile)");
console.log(await call("apply_layout", { board: "flow", algorithm: "layered", direction: "RIGHT" }));
await client.close();
process.exit(0);
