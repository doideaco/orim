/**
 * Reading order for exports (and later, the accessibility tree):
 * frames first (spatially sorted), each with its children spatially sorted,
 * then loose nodes. "Spatial" = rows top-to-bottom, left-to-right within
 * a row band, which matches how people read a board.
 */
import type { BoardComment, Connector, FrameNode, Node } from "@orim/schema";

export interface ExportBoard {
  title?: string;
  nodes: Node[];
  connectors: Connector[];
  comments?: BoardComment[];
}

const ROW_BAND = 80; // world units: nodes whose tops are this close share a row

export function spatialSort<T extends { x: number; y: number }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    if (Math.abs(a.y - b.y) > ROW_BAND) return a.y - b.y;
    return a.x - b.x;
  });
}

export interface OrderedBoard {
  frames: { frame: FrameNode; children: Node[] }[];
  loose: Node[];
}

export function orderBoard(board: ExportBoard): OrderedBoard {
  const frames = spatialSort(
    board.nodes.filter((n): n is FrameNode => n.type === "frame"),
  );
  const frameIds = new Set(frames.map((f) => f.id));
  const byParent = new Map<string, Node[]>();
  const loose: Node[] = [];
  for (const n of board.nodes) {
    if (n.type === "frame") continue;
    if (n.parent && frameIds.has(n.parent)) {
      const list = byParent.get(n.parent) ?? [];
      list.push(n);
      byParent.set(n.parent, list);
    } else {
      loose.push(n);
    }
  }
  return {
    frames: frames.map((frame) => ({
      frame,
      children: spatialSort(byParent.get(frame.id) ?? []),
    })),
    loose: spatialSort(loose),
  };
}

/** Human-readable one-line label for a node. */
export function nodeLabel(n: Node): string {
  switch (n.type) {
    case "sticky": return n.text || "(empty sticky)";
    case "shape": return n.text || `(${n.kind})`;
    case "text": return n.text || "(empty text)";
    case "frame": return n.title;
    case "ink": return "(drawing)";
    case "table": return n.title;
  }
}
