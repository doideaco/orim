/**
 * MCP smoke test: spawns the server over stdio as a real MCP client,
 * exercises every tool against the live sync server, prints results.
 * Run with the sync server up:  node --import tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", new URL("../src/server.ts", import.meta.url).pathname],
});
const client = new Client({ name: "orim-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as { type: string; text?: string }[])[0];
  return first?.text ?? "(no text)";
};

console.log("\n== list_boards ==\n" + (await call("list_boards", {})));

console.log("\n== create_objects ==");
const created = await call("create_objects", {
  board: "main",
  nodes: [
    { type: "frame", x: 560, y: 620, w: 560, h: 260, title: "Agent ideas" },
    { type: "sticky", x: 590, y: 660, text: "cluster stickies\nby theme", color: "violet", parent: "$0" },
    { type: "sticky", x: 790, y: 660, text: "transcript →\njourney map", color: "teal", parent: "$0" },
    { type: "shape", x: 990, y: 665, kind: "diamond", text: "ship?", color: "orange", w: 110, h: 110 },
  ],
  connectors: [
    { from: "$2", to: "$3", label: "next", style: "arrow" },
  ],
});
console.log(created);

const firstStickyId = /\$1 → (\S+)/.exec(created)?.[1];
console.log("\n== update_objects ==\n" +
  (await call("update_objects", {
    board: "main",
    updates: [{ id: firstStickyId, color: "pink" }],
  })));

console.log("\n== read_board (markdown) ==\n" + (await call("read_board", { board: "main" })));
console.log("\n== read_board (mermaid) ==\n" + (await call("read_board", { board: "main", format: "mermaid" })));

await client.close();
process.exit(0);
