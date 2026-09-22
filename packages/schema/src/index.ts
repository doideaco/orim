/**
 * @orim/schema — the Orim file format, v0.
 *
 * A board is a typed graph with a spatial projection:
 *  - nodes: spatial objects (sticky, shape, frame, text, ink, table, embed)
 *  - connectors: first-class edges between nodes (or free points)
 *  - frames give the graph hierarchy via `parent`, which also defines
 *    accessibility reading order and Markdown export structure.
 *
 * Everything here must remain serializable to plain JSON and round-trippable.
 * Breaking changes bump SCHEMA_VERSION and require a migration.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 0;

export const NodeId = z.string().min(1);
export type NodeId = z.infer<typeof NodeId>;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const Vec = z.object({ x: z.number(), y: z.number() });
export type Vec = z.infer<typeof Vec>;

/** Named palette colors, not raw hex: lets themes re-map them and lets us
 *  enforce WCAG AA contrast pairs (fill ↔ text) centrally. */
export const PaletteColor = z.enum([
  "gray", "blue", "teal", "green", "yellow", "orange", "red", "pink", "violet",
]);
export type PaletteColor = z.infer<typeof PaletteColor>;

const BaseNode = z.object({
  id: NodeId,
  /** Parent frame/group id, or null at board root. Drives reading order. */
  parent: NodeId.nullable().default(null),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  rotation: z.number().default(0),
  /** Sort key among siblings (fractional indexing). */
  index: z.string().default("a0"),
  locked: z.boolean().default(false),
  /** Open bag for typed, user/agent-defined data. This is what makes a board
   *  a database: votes, owners, jira keys, arbitrary fields. */
  data: z.record(z.string(), z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export const StickyNode = BaseNode.extend({
  type: z.literal("sticky"),
  text: z.string().default(""),
  color: PaletteColor.default("yellow"),
  author: z.string().optional(),
});

export const ShapeNode = BaseNode.extend({
  type: z.literal("shape"),
  kind: z.enum(["rect", "ellipse", "diamond", "pill"]).default("rect"),
  text: z.string().default(""),
  color: PaletteColor.default("blue"),
  fillStyle: z.enum(["solid", "outline", "none"]).default("solid"),
});

export const FrameNode = BaseNode.extend({
  type: z.literal("frame"),
  title: z.string().default("Frame"),
});

export const TextNode = BaseNode.extend({
  type: z.literal("text"),
  /** Markdown subset; rich editing happens in ProseMirror, stored as md. */
  text: z.string().default(""),
  fontSize: z.number().default(16),
});

export const InkNode = BaseNode.extend({
  type: z.literal("ink"),
  /** Points relative to (x, y), flattened [x0, y0, p0, x1, y1, p1, ...]. */
  points: z.array(z.number()),
  color: PaletteColor.default("gray"),
  size: z.number().default(4),
});

export const TableColumn = z.object({
  id: z.string(),
  name: z.string().default(""),
  /** Relative width weight; rendered widths scale to fit the node. */
  w: z.number().positive().default(160),
});
export type TableColumn = z.infer<typeof TableColumn>;

export const TableRow = z.object({
  id: z.string(),
  /** columnId -> cell text. */
  cells: z.record(z.string(), z.string()).default({}),
});
export type TableRow = z.infer<typeof TableRow>;

/** A grid/sheet on the canvas. Rows are structured records: they can be
 *  connected to, generated into stickies, and carried through exports. */
export const TableNode = BaseNode.extend({
  type: z.literal("table"),
  title: z.string().default("Table"),
  columns: z.array(TableColumn),
  rows: z.array(TableRow),
});
export type TableNode = z.infer<typeof TableNode>;

export const Node = z.discriminatedUnion("type", [
  StickyNode,
  ShapeNode,
  FrameNode,
  TextNode,
  InkNode,
  TableNode,
]);
export type Node = z.infer<typeof Node>;
export type NodeType = Node["type"];
export type StickyNode = z.infer<typeof StickyNode>;
export type ShapeNode = z.infer<typeof ShapeNode>;
export type FrameNode = z.infer<typeof FrameNode>;
export type TextNode = z.infer<typeof TextNode>;
export type InkNode = z.infer<typeof InkNode>;

// ---------------------------------------------------------------------------
// Connectors (edges)
// ---------------------------------------------------------------------------

/** An endpoint is either bound to a node (follows it) or a free point.
 *  Binding to a table may name a row (the connector anchors to that row's
 *  edge) and a column — a precise cell, used when a drop on a cell turns
 *  into a `$source` binding instead of a connector. */
export const Endpoint = z.union([
  z.object({
    node: NodeId,
    anchor: z.enum(["auto", "n", "s", "e", "w"]).default("auto"),
    row: z.string().optional(),
    column: z.string().optional(),
  }),
  z.object({ point: Vec }),
]);
export type Endpoint = z.infer<typeof Endpoint>;

export const Connector = z.object({
  id: NodeId,
  type: z.literal("connector"),
  from: Endpoint,
  to: Endpoint,
  label: z.string().default(""),
  style: z.enum(["line", "arrow", "double"]).default("arrow"),
  index: z.string().default("a0"),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type Connector = z.infer<typeof Connector>;

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const CommentReply = z.object({
  author: z.string(),
  body: z.string(),
  at: z.number(),
});
export type CommentReply = z.infer<typeof CommentReply>;

/** A threaded comment, anchored to a node (follows it) or a free point. */
export const BoardComment = z.object({
  id: z.string(),
  anchor: z.union([z.object({ node: NodeId }), z.object({ point: Vec })]),
  author: z.string(),
  body: z.string(),
  at: z.number(),
  resolved: z.boolean().default(false),
  replies: z.array(CommentReply).default([]),
});
export type BoardComment = z.infer<typeof BoardComment>;

// ---------------------------------------------------------------------------
// Board document
// ---------------------------------------------------------------------------

export const BoardDoc = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  title: z.string().default("Untitled board"),
  nodes: z.record(NodeId, Node),
  connectors: z.record(NodeId, Connector),
  comments: z.record(z.string(), BoardComment).default({}),
});
export type BoardDoc = z.infer<typeof BoardDoc>;

/** Validate an unknown payload (import, MCP write, migration target). */
export function parseBoard(input: unknown): BoardDoc {
  return BoardDoc.parse(input);
}

export function emptyBoard(id: string, title = "Untitled board"): BoardDoc {
  return { schemaVersion: SCHEMA_VERSION, id, title, nodes: {}, connectors: {}, comments: {} };
}

// ---------------------------------------------------------------------------
// Derived content
// ---------------------------------------------------------------------------

/**
 * A node whose text derives from a table cell stores the binding at
 * `data.$source`. The cell is the source of truth: edit the node and the
 * cell updates; edit the cell and every bound node follows. The node's
 * position stays entirely its own.
 */
export interface CellSource {
  table: string;
  row: string;
  column: string;
}

export function cellSource(n: Node): CellSource | null {
  const s = (n.data as { $source?: unknown })?.$source;
  if (
    s && typeof s === "object" &&
    typeof (s as CellSource).table === "string" &&
    typeof (s as CellSource).row === "string" &&
    typeof (s as CellSource).column === "string"
  ) {
    return s as CellSource;
  }
  return null;
}
