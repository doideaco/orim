/**
 * @orim/layout — auto-layout for board content.
 *
 * `layered` wraps ELK's layered algorithm for anything with edges
 * (flowcharts, dependency graphs); `grid` packs unconnected nodes into
 * tidy rows. Both return new positions anchored at the original content's
 * top-left corner, so layout never teleports work across the board.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { Connector, Node } from "@orim/schema";

export interface Position {
  x: number;
  y: number;
}

export type LayoutDirection = "RIGHT" | "DOWN" | "LEFT" | "UP";

const anchorOf = (nodes: Node[]): Position => ({
  x: Math.min(...nodes.map((n) => n.x)),
  y: Math.min(...nodes.map((n) => n.y)),
});

/** ELK layered layout over the given nodes and the connectors among them. */
export async function layered(
  nodes: Node[],
  connectors: Connector[],
  options: { direction?: LayoutDirection; spacing?: number } = {},
): Promise<Map<string, Position>> {
  if (nodes.length < 2) return new Map();
  const ids = new Set(nodes.map((n) => n.id));
  const edges = connectors.filter(
    (c) => "node" in c.from && ids.has(c.from.node) && "node" in c.to && ids.has(c.to.node),
  );
  const spacing = options.spacing ?? 48;

  const elk = new ELK();
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction ?? "RIGHT",
      "elk.spacing.nodeNode": String(spacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing * 2),
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.w, height: n.h })),
    edges: edges.map((c) => ({
      id: c.id,
      sources: [(c.from as { node: string }).node],
      targets: [(c.to as { node: string }).node],
    })),
  });

  const anchor = anchorOf(nodes);
  const out = new Map<string, Position>();
  for (const child of result.children ?? []) {
    out.set(child.id, { x: anchor.x + (child.x ?? 0), y: anchor.y + (child.y ?? 0) });
  }
  return out;
}

/** Pack nodes into a grid (reading order preserved), e.g. to tidy stickies. */
export function grid(
  nodes: Node[],
  options: { columns?: number; gap?: number } = {},
): Map<string, Position> {
  if (nodes.length < 2) return new Map();
  const gap = options.gap ?? 32;
  const sorted = [...nodes].sort((a, b) =>
    Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x,
  );
  const columns = options.columns ?? Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const colW = Math.max(...sorted.map((n) => n.w)) + gap;
  const rowH = Math.max(...sorted.map((n) => n.h)) + gap;
  const anchor = anchorOf(nodes);
  const out = new Map<string, Position>();
  sorted.forEach((n, i) => {
    out.set(n.id, {
      x: anchor.x + (i % columns) * colW,
      y: anchor.y + Math.floor(i / columns) * rowH,
    });
  });
  return out;
}

/**
 * First free w×h rectangle near `near` (or right of existing content),
 * scanning outward on a coarse grid. Used so agents never place blind.
 */
export function findEmptySpace(
  nodes: Node[],
  w: number,
  h: number,
  near?: Position,
  margin = 40,
): Position {
  if (!nodes.length) return near ?? { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const minY = Math.min(...nodes.map((n) => n.y));
  const start = near ?? { x: maxX + margin * 2, y: minY };
  const step = 60;
  const collides = (x: number, y: number) =>
    nodes.some(
      (n) =>
        x - margin < n.x + n.w && x + w + margin > n.x &&
        y - margin < n.y + n.h && y + h + margin > n.y,
    );
  // Spiral outward from the starting point.
  for (let ring = 0; ring < 60; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = start.x + dx * step;
        const y = start.y + dy * step;
        if (!collides(x, y)) return { x, y };
      }
    }
  }
  return { x: maxX + margin * 2, y: minY };
}
