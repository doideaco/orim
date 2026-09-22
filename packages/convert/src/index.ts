import { SCHEMA_VERSION, type BoardDoc } from "@orim/schema";
import type { ExportBoard } from "./order";

export * from "./order";
export * from "./markdown";
export * from "./mermaid";
export * from "./svg";
export * from "./import-grid";
export * from "./import-text";
export * from "./templates";

/** Board → the open Orim file format (schema-validated JSON shape). */
export function boardToJSON(board: ExportBoard, id = "board"): BoardDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: board.title ?? "Untitled board",
    nodes: Object.fromEntries(board.nodes.map((n) => [n.id, n])),
    connectors: Object.fromEntries(board.connectors.map((c) => [c.id, c])),
    comments: Object.fromEntries((board.comments ?? []).map((c) => [c.id, c])),
  };
}
export * from "./import-miro";
