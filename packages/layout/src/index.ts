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

export * from "./synthesize";

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

  // Authors declare the forward flow in order, but a node can be referenced
  // lines before it is defined, so neither node nor edge model order can be
  // trusted to tell a return loop from the forward path. Find the loops
  // ourselves: DFS in declaration order from the sources; an edge into a
  // node still on the stack is a back-edge. ELK ranks the remaining DAG and
  // the loops still render — they just can't drag a mid-flow node upward.
  const srcOf = (c: Connector) => (c.from as { node: string }).node;
  const dstOf = (c: Connector) => (c.to as { node: string }).node;
  const outgoing = new Map<string, Connector[]>();
  const hasIncoming = new Set<string>();
  for (const c of edges) {
    if (!outgoing.has(srcOf(c))) outgoing.set(srcOf(c), []);
    outgoing.get(srcOf(c))!.push(c);
    hasIncoming.add(dstOf(c));
  }
  const backEdges = new Set<string>();
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (id: string): void => {
    visited.add(id);
    stack.add(id);
    for (const c of outgoing.get(id) ?? []) {
      const to = dstOf(c);
      if (stack.has(to)) backEdges.add(c.id);
      else if (!visited.has(to)) dfs(to);
    }
    stack.delete(id);
  };
  for (const n of nodes) if (!hasIncoming.has(n.id) && !visited.has(n.id)) dfs(n.id);
  for (const n of nodes) if (!visited.has(n.id)) dfs(n.id); // source-less cycles
  const ranked = edges.filter((c) => !backEdges.has(c.id));

  const elk = new ELK();
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction ?? "RIGHT",
      "elk.spacing.nodeNode": String(spacing),
      // 1.5x, not 2x, and no label layers in the model: labels render as
      // chips on the line, so what they need is in-rank clearance (the
      // caller's spacing), never their own rank — modelling them inline
      // once doubled the board's height and fit-zoom turned to mush.
      "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing * 1.5),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // Network-simplex placement keeps chains dead straight; the default
      // Brandes-Köpf leaves near-miss jogs (a spine offset by half a port)
      // that read as sloppy at working zoom.
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.w, height: n.h })),
    edges: ranked.map((c) => ({
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

  // Snap near-miss chains flush. Barycenter placement leaves a child a
  // hair off its only parent's center where a side branch pulls on it —
  // and a 30px jog reads as a mistake where a real offset reads as a
  // decision. Walk ranks top-down and align such children when their
  // rank has the room.
  const SNAP = 36;
  const CLEAR = 24;
  const vertical = (options.direction ?? "RIGHT") === "DOWN" || options.direction === "UP";
  const main = (n: Node) => (vertical ? out.get(n.id)!.x + n.w / 2 : out.get(n.id)!.y + n.h / 2);
  const halfSpan = (n: Node) => (vertical ? n.w : n.h) / 2;
  const rankOf = (n: Node) => (vertical ? out.get(n.id)!.y : out.get(n.id)!.x);
  const parents = new Map<string, string[]>();
  for (const c of ranked) {
    const to = (c.to as { node: string }).node;
    if (!parents.has(to)) parents.set(to, []);
    parents.get(to)!.push((c.from as { node: string }).node);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = nodes.filter((n) => out.has(n.id));
  const ranks = new Map<number, Node[]>();
  for (const n of placed) {
    const r = rankOf(n);
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r)!.push(n);
  }
  for (const r of [...ranks.keys()].sort((a, b) => a - b)) {
    const row = ranks.get(r)!.sort((a, b) => main(a) - main(b));
    row.forEach((n, i) => {
      const ps = parents.get(n.id);
      if (!ps || ps.length !== 1 || !byId.has(ps[0]!) || !out.has(ps[0]!)) return;
      const target = main(byId.get(ps[0]!)!);
      const delta = target - main(n);
      if (delta === 0 || Math.abs(delta) > SNAP) return;
      const left = row[i - 1];
      const right = row[i + 1];
      const newMain = main(n) + delta;
      if (left && newMain - halfSpan(n) < main(left) + halfSpan(left) + CLEAR) return;
      if (right && newMain + halfSpan(n) > main(right) - halfSpan(right) - CLEAR) return;
      const p = out.get(n.id)!;
      out.set(n.id, vertical ? { x: p.x + delta, y: p.y } : { x: p.x, y: p.y + delta });
    });
  }
  return out;
}

/**
 * Tidy tree (Reingold–Tilford style) for strict hierarchies — org charts,
 * outlines. Children stay grouped and ordered under their parent, and every
 * parent sits centered over its subtree, which generic layered layout does
 * not guarantee. Non-tree edges (second parents, cycles) are ignored.
 */
export function tree(
  nodes: Node[],
  connectors: Connector[],
  options: { hGap?: number; vGap?: number } = {},
): Map<string, Position> {
  if (nodes.length < 2) return new Map();
  const hGap = options.hGap ?? 36;
  const vGap = options.vGap ?? 88;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const c of connectors) {
    if (!("node" in c.from) || !("node" in c.to)) continue;
    const from = c.from.node;
    const to = c.to.node;
    if (!byId.has(from) || !byId.has(to) || from === to || hasParent.has(to)) continue;
    hasParent.add(to);
    if (!children.has(from)) children.set(from, []);
    children.get(from)!.push(to);
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  if (!roots.length) return new Map(); // pure cycle: let the caller fall back

  // Subtree spans, post-order (iterative-safe via memo + cycle guard).
  const span = new Map<string, number>();
  const measuring = new Set<string>();
  const measure = (id: string): number => {
    const memo = span.get(id);
    if (memo !== undefined) return memo;
    if (measuring.has(id)) return byId.get(id)!.w;
    measuring.add(id);
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((s, k, i) => s + measure(k) + (i ? hGap : 0), 0);
    const w = Math.max(byId.get(id)!.w, kidsW);
    span.set(id, w);
    measuring.delete(id);
    return w;
  };

  // Row heights per depth, so uneven nodes stay on shared baselines.
  const depth = new Map<string, number>();
  const queue: [string, number][] = roots.map((r) => [r, 0]);
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const k of children.get(id) ?? []) queue.push([k, d + 1]);
  }
  const rowH: number[] = [];
  for (const [id, d] of depth) rowH[d] = Math.max(rowH[d] ?? 0, byId.get(id)!.h);
  const rowY: number[] = [];
  let nextY = 0;
  rowH.forEach((h, d) => {
    rowY[d] = nextY;
    nextY += h + vGap;
  });

  const out = new Map<string, Position>();
  const place = (id: string, left: number): void => {
    if (out.has(id)) return;
    const n = byId.get(id)!;
    const w = measure(id);
    const d = depth.get(id) ?? 0;
    out.set(id, {
      x: left + (w - n.w) / 2,
      y: rowY[d]! + (rowH[d]! - n.h) / 2,
    });
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((s, k, i) => s + measure(k) + (i ? hGap : 0), 0);
    let cursor = left + (w - kidsW) / 2;
    for (const k of kids) {
      place(k, cursor);
      cursor += measure(k) + hGap;
    }
  };
  let left = 0;
  for (const r of roots) {
    place(r, left);
    left += measure(r) + hGap * 2;
  }

  const anchor = anchorOf(nodes);
  return new Map([...out].map(([id, p]) => [id, { x: anchor.x + p.x, y: anchor.y + p.y }]));
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
