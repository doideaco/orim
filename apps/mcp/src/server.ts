/**
 * Orim MCP server — boards as structured data for AI agents.
 *
 * Agents read a board as Markdown/JSON/Mermaid/SVG and write typed objects
 * back. Every write goes through the live sync pipeline, so people watching
 * the board see agent edits appear in real time.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Connector, Endpoint, Node, PaletteColor } from "@orim/schema";
import { boardToJSON, boardToMarkdown, boardToMermaid, boardToSVG } from "@orim/convert";
import { findEmptySpace, grid, layered } from "@orim/layout";
import { docName, openBoard, settle, toExportBoard } from "./boards";

const DB_PATH =
  process.env.ORIM_DB_PATH ?? new URL("../../sync/.data/boards.db", import.meta.url).pathname;

let idCounter = 0;
const newId = () => `agent-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

const server = new McpServer({ name: "orim", version: "0.1.0" });

const boardArg = z.string().describe('Board name, e.g. "main" (the ?b= value in the board URL)');

const color = z
  .enum(["gray", "blue", "teal", "green", "yellow", "orange", "red", "pink", "violet"])
  .optional();

const CreateNode = z.object({
  type: z.enum(["sticky", "shape", "frame", "text"]),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  text: z.string().optional().describe("Sticky/shape/text content"),
  title: z.string().optional().describe("Frame title"),
  kind: z.enum(["rect", "ellipse", "diamond", "pill"]).optional().describe("Shape kind"),
  color,
  parent: z.string().optional().describe("Frame id to place this node inside"),
});

const CreateConnector = z.object({
  from: z.union([z.string().describe("node id"), z.object({ x: z.number(), y: z.number() })]),
  to: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]),
  label: z.string().optional(),
  style: z.enum(["line", "arrow", "double"]).optional(),
});

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  sticky: { w: 180, h: 120 },
  shape: { w: 160, h: 100 },
  frame: { w: 480, h: 320 },
  text: { w: 280, h: 28 },
};

function buildNode(input: z.infer<typeof CreateNode>, index: string): Node {
  const size = DEFAULT_SIZE[input.type]!;
  const base = {
    id: newId(),
    parent: input.parent ?? null,
    x: input.x,
    y: input.y,
    w: input.w ?? size.w,
    h: input.h ?? size.h,
    rotation: 0,
    index,
    locked: false,
    data: {},
  };
  const c = (fallback: PaletteColor): PaletteColor => input.color ?? fallback;
  switch (input.type) {
    case "sticky":
      return { ...base, type: "sticky", text: input.text ?? "", color: c("yellow"), author: "agent" };
    case "shape":
      return {
        ...base, type: "shape", kind: input.kind ?? "rect",
        text: input.text ?? "", color: c("blue"), fillStyle: "solid",
      };
    case "frame":
      return { ...base, type: "frame", title: input.title ?? input.text ?? "Frame" };
    case "text":
      return { ...base, type: "text", text: input.text ?? "", fontSize: 16 };
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.tool(
  "list_boards",
  "List all Orim boards on this server with object counts and last-updated times.",
  {},
  async () => {
    if (!existsSync(DB_PATH)) return text("No boards yet (sync server has no database).");
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT name, length(state) AS bytes, updated_at FROM boards ORDER BY updated_at DESC")
        .all() as { name: string; bytes: number; updated_at: number }[];
      const lines = rows.map((r) => {
        const bare = r.name.replace(/^orim-/, "");
        return `- ${bare} (${r.bytes} bytes, updated ${new Date(r.updated_at).toISOString()})`;
      });
      return text(lines.length ? lines.join("\n") : "No boards yet.");
    } finally {
      db.close();
    }
  },
);

server.tool(
  "read_board",
  "Read a board. Formats: markdown (reading-order outline — best for understanding), json (full typed structure with ids — required before updating), mermaid (diagram structure), svg (visual render).",
  {
    board: boardArg,
    format: z.enum(["markdown", "json", "mermaid", "svg"]).default("markdown"),
  },
  async ({ board, format }) => {
    const { store } = await openBoard(board);
    const exp = toExportBoard(store, board);
    switch (format) {
      case "json": return text(JSON.stringify(boardToJSON(exp, docName(board)), null, 2));
      case "mermaid": return text(boardToMermaid(exp));
      case "svg": return text(boardToSVG(exp));
      default: return text(boardToMarkdown(exp));
    }
  },
);

server.tool(
  "create_objects",
  "Create nodes and/or connectors on a board. Everyone viewing the board sees them appear live. Connector endpoints reference node ids (existing ones, or by array position via $0, $1, … for nodes created in this same call). Read the board first and place new objects in EMPTY space — never overlapping existing content. Leave breathing room: at least 60 units between connected nodes so connectors and labels stay readable, and make frames comfortably larger than their contents.",
  {
    board: boardArg,
    nodes: z.array(CreateNode).default([]),
    connectors: z.array(CreateConnector).default([]),
  },
  async ({ board, nodes, connectors }) => {
    const { store } = await openBoard(board);
    const created: Node[] = [];
    store.transact(() => {
      for (const input of nodes) {
        let parent = input.parent;
        if (parent) {
          const m = /^\$(\d+)$/.exec(parent);
          if (m) parent = created[Number(m[1])]?.id;
          if (!parent || (!m && !store.getNode(parent))) {
            throw new Error(`Unknown parent reference: ${input.parent}`);
          }
        }
        const node = buildNode({ ...input, parent }, store.topIndex());
        store.upsertNode(node);
        created.push(node);
      }
      for (const input of connectors) {
        const resolve = (ref: string | { x: number; y: number }): Endpoint => {
          if (typeof ref !== "string") return { point: ref };
          const m = /^\$(\d+)$/.exec(ref);
          const nodeId = m ? created[Number(m[1])]?.id : ref;
          if (!nodeId || (!m && !store.getNode(nodeId))) {
            throw new Error(`Unknown node reference: ${ref}`);
          }
          return { node: nodeId, anchor: "auto" };
        };
        const connector: Connector = {
          id: newId(),
          type: "connector",
          from: resolve(input.from),
          to: resolve(input.to),
          label: input.label ?? "",
          style: input.style ?? "arrow",
          index: store.topIndex(),
          data: {},
        };
        store.upsertConnector(connector);
      }
    });
    await settle();

    // Overlap check: warn the agent when new objects land on existing
    // content, so a bad layout gets fixed instead of shipped silently.
    const createdIds = new Set(created.map((n) => n.id));
    const warnings: string[] = [];
    for (const n of created) {
      for (const other of store.nodes.values()) {
        if (createdIds.has(other.id) || other.type === "frame") continue;
        if (n.type === "frame" && other.parent === n.id) continue;
        const overlaps =
          n.x < other.x + other.w && n.x + n.w > other.x &&
          n.y < other.y + other.h && n.y + n.h > other.y;
        if (overlaps) {
          warnings.push(
            `WARNING: new ${n.type} ${n.id} overlaps existing ${other.type} ${other.id} at (${Math.round(other.x)}, ${Math.round(other.y)}) — move one of them (update_objects) so the board stays readable.`,
          );
        }
      }
    }

    return text(
      `Created ${created.length} node(s), ${connectors.length} connector(s).\n` +
        created.map((n, i) => `$${i} → ${n.id} (${n.type})`).join("\n") +
        (warnings.length ? `\n\n${warnings.join("\n")}` : ""),
    );
  },
);

server.tool(
  "update_objects",
  "Update fields on existing nodes by id (position, size, text, color, title, parent). Read the board as json first to get ids.",
  {
    board: boardArg,
    updates: z.array(
      z.object({
        id: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        text: z.string().optional(),
        title: z.string().optional(),
        color,
        parent: z.string().nullable().optional(),
      }),
    ),
  },
  async ({ board, updates }) => {
    const { store } = await openBoard(board);
    let applied = 0;
    store.transact(() => {
      for (const { id, ...patch } of updates) {
        if (!store.getNode(id)) continue;
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        store.updateNode(id, clean as Partial<Node>);
        applied++;
      }
    });
    await settle();
    return text(`Updated ${applied}/${updates.length} node(s).`);
  },
);

server.tool(
  "delete_objects",
  "Delete nodes and/or connectors by id. Deleting a node also removes connectors attached to it.",
  {
    board: boardArg,
    node_ids: z.array(z.string()).default([]),
    connector_ids: z.array(z.string()).default([]),
  },
  async ({ board, node_ids, connector_ids }) => {
    const { store } = await openBoard(board);
    store.transact(() => {
      for (const id of node_ids) store.deleteNode(id);
      for (const id of connector_ids) store.deleteConnector(id);
    });
    await settle();
    return text(`Deleted ${node_ids.length} node(s), ${connector_ids.length} connector(s).`);
  },
);

server.tool(
  "apply_layout",
  "Auto-arrange nodes. 'layered' (ELK) flows connected nodes along their edges — use for flowcharts and dependency graphs. 'grid' packs nodes into tidy rows — use for loose stickies. Defaults to all top-level non-frame nodes; pass node_ids to layout a subset (e.g. one cluster or one frame's children).",
  {
    board: boardArg,
    node_ids: z.array(z.string()).optional(),
    algorithm: z.enum(["layered", "grid"]).default("layered"),
    direction: z.enum(["RIGHT", "DOWN", "LEFT", "UP"]).default("RIGHT")
      .describe("Flow direction for layered layout"),
    columns: z.number().int().positive().optional().describe("Column count for grid layout"),
  },
  async ({ board, node_ids, algorithm, direction, columns }) => {
    const { store } = await openBoard(board);
    const targets = (node_ids ?? [...store.nodes.keys()])
      .map((id) => store.getNode(id))
      .filter((n): n is Node => !!n && n.type !== "frame" && (node_ids ? true : n.parent === null));
    if (targets.length < 2) return text("Need at least 2 nodes to lay out.");
    const positions =
      algorithm === "grid"
        ? grid(targets, { columns })
        : await layered(targets, [...store.connectors.values()], { direction });
    store.transact(() => {
      for (const [id, pos] of positions) store.updateNode(id, pos);
    });
    await settle();
    return text(`Rearranged ${positions.size} node(s) with ${algorithm} layout.`);
  },
);

server.tool(
  "find_empty_space",
  "Find a free position for a w×h object (nothing within 40 units). Use before create_objects so new content never lands on existing work.",
  {
    board: boardArg,
    w: z.number().positive(),
    h: z.number().positive(),
    near: z.object({ x: z.number(), y: z.number() }).optional()
      .describe("Preferred area; defaults to right of existing content"),
  },
  async ({ board, w, h, near }) => {
    const { store } = await openBoard(board);
    const pos = findEmptySpace([...store.nodes.values()], w, h, near);
    return text(`Free space for ${w}×${h}: x=${Math.round(pos.x)}, y=${Math.round(pos.y)}`);
  },
);

await server.connect(new StdioServerTransport());
console.error("[orim-mcp] ready (stdio)");
