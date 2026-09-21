/**
 * Obstacle-avoiding connector routing.
 *
 * Fast path: the plain elbow route, kept whenever it doesn't cross any
 * node. Otherwise: A* over a sparse orthogonal lattice built from the
 * inflated edges of nearby obstacles, with a bend penalty so routes
 * prefer long straight runs — the classic orthogonal routing approach.
 */
import type { Connector, Endpoint, Node } from "@orim/schema";
import type { Point, Rect } from "./camera";
import {
  anchorPoint, anchorSide, dominantSide, elbowRoute, nodeRect, rectCenter,
  type Side,
} from "./geometry";

const MARGIN = 16; // clearance kept around obstacles
const STUB = 24;
const BEND_COST = 60;
const REGION_PAD = 160; // how far around the endpoints we look for obstacles

const SIDE_VEC: Record<Side, Point> = {
  n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 },
};

interface ResolvedEndpoint {
  p: Point;
  side: Side | null;
  nodeId: string | null;
}

function resolveEndpoints(
  c: Connector,
  getNode: (id: string) => Node | undefined,
): { from: ResolvedEndpoint; to: ResolvedEndpoint } | null {
  const ref = (e: Endpoint): Point | null => {
    if ("point" in e) return e.point;
    const n = getNode(e.node);
    return n ? rectCenter(nodeRect(n)) : null;
  };
  const fromRef = ref(c.from);
  const toRef = ref(c.to);
  if (!fromRef || !toRef) return null;
  const resolve = (e: Endpoint, towards: Point): ResolvedEndpoint | null => {
    if ("point" in e) return { p: e.point, side: null, nodeId: null };
    const n = getNode(e.node);
    if (!n) return null;
    // Row-level endpoint on a table: anchor at that row's edge, east or
    // west (rows read sideways), whichever faces the other end.
    if (e.row && n.type === "table") {
      const rowIndex = n.rows.findIndex((r) => r.id === e.row);
      if (rowIndex >= 0) {
        const rowY = Math.min(n.y + (rowIndex + 1.5) * 34, n.y + n.h - 17);
        const side: Side = towards.x >= n.x + n.w / 2 ? "e" : "w";
        return {
          p: { x: side === "e" ? n.x + n.w : n.x, y: rowY },
          side,
          nodeId: e.node,
        };
      }
    }
    const side = anchorSide(nodeRect(n), e.anchor, towards);
    return { p: anchorPoint(nodeRect(n), side, towards), side, nodeId: e.node };
  };
  const from = resolve(c.from, toRef);
  const to = resolve(c.to, fromRef);
  return from && to ? { from, to } : null;
}

/** Liang-Barsky style test: does segment a-b properly cross rect r? */
function segmentCrossesRect(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clips: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      // Parallel to this edge pair: on-or-outside the boundary is a miss,
      // so lattice lines lying exactly on inflated edges stay routable.
      if (q < 1e-6) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t1 - t0 > 1e-6;
}

function routeBlocked(route: Point[], obstacles: Rect[]): boolean {
  for (let i = 0; i < route.length - 1; i++) {
    for (const r of obstacles) {
      if (segmentCrossesRect(route[i]!, route[i + 1]!, r)) return true;
    }
  }
  return false;
}

function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const prev = out[out.length - 2];
    if (
      last && prev &&
      ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))
    ) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/** A* over the lattice of candidate coordinates. Direction is part of the
 *  state so turns can be penalized. */
function orthoAStar(
  start: Point,
  startDir: number, // 0 E, 1 S, 2 W, 3 N, -1 any
  goal: Point,
  xs: number[],
  ys: number[],
  obstacles: Rect[],
): Point[] | null {
  const xi = xs.indexOf(start.x);
  const yi = ys.indexOf(start.y);
  const gxi = xs.indexOf(goal.x);
  const gyi = ys.indexOf(goal.y);
  if (xi < 0 || yi < 0 || gxi < 0 || gyi < 0) return null;

  const W = xs.length;
  const H = ys.length;
  const key = (x: number, y: number, d: number) => (x * H + y) * 5 + d + 1;
  const gScore = new Map<number, number>();
  interface State { x: number; y: number; d: number }
  const cameFrom = new Map<number, State | null>();
  const h = (x: number, y: number) => Math.abs(xs[x]! - goal.x) + Math.abs(ys[y]! - goal.y);

  interface QItem extends State { g: number; f: number }
  const open: QItem[] = [{ x: xi, y: yi, d: startDir, g: 0, f: h(xi, yi) }];
  gScore.set(key(xi, yi, startDir), 0);
  cameFrom.set(key(xi, yi, startDir), null);

  const DIRS = [
    { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 },
  ];

  let iterations = 0;
  while (open.length && iterations++ < 20000) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[best]!.f) best = i;
    const cur = open.splice(best, 1)[0]!;
    if (cur.x === gxi && cur.y === gyi) {
      const pts: Point[] = [];
      let s: State | null = cur;
      while (s) {
        pts.push({ x: xs[s.x]!, y: ys[s.y]! });
        s = cameFrom.get(key(s.x, s.y, s.d)) ?? null;
      }
      return pts.reverse();
    }
    if (cur.g > (gScore.get(key(cur.x, cur.y, cur.d)) ?? Infinity)) continue;

    for (let d = 0; d < 4; d++) {
      const nx = cur.x + DIRS[d]!.dx;
      const ny = cur.y + DIRS[d]!.dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const a = { x: xs[cur.x]!, y: ys[cur.y]! };
      const b = { x: xs[nx]!, y: ys[ny]! };
      let blocked = false;
      for (const r of obstacles) {
        if (segmentCrossesRect(a, b, r)) { blocked = true; break; }
      }
      if (blocked) continue;
      const stepCost =
        Math.abs(b.x - a.x) + Math.abs(b.y - a.y) +
        (cur.d !== -1 && cur.d !== d ? BEND_COST : 0);
      const g = cur.g + stepCost;
      const k = key(nx, ny, d);
      if (g < (gScore.get(k) ?? Infinity)) {
        gScore.set(k, g);
        cameFrom.set(k, { x: cur.x, y: cur.y, d: cur.d });
        open.push({ x: nx, y: ny, d, g, f: g + h(nx, ny) });
      }
    }
  }
  return null;
}

const sideToDir = (s: Side | null): number =>
  s === "e" ? 0 : s === "s" ? 1 : s === "w" ? 2 : s === "n" ? 3 : -1;

/**
 * Route a connector, detouring around nodes in its way. `nodes` is the
 * board content to avoid (frames and the endpoint nodes are ignored).
 */
export function routeConnector(
  c: Connector,
  getNode: (id: string) => Node | undefined,
  nodes: Iterable<Node>,
): Point[] | null {
  const ends = resolveEndpoints(c, getNode);
  if (!ends) return null;
  const { from, to } = ends;

  const plain = elbowRoute(from.p, from.side, to.p, to.side);

  // Obstacles: content nodes near the route's bounding region.
  const minX = Math.min(from.p.x, to.p.x) - REGION_PAD;
  const maxX = Math.max(from.p.x, to.p.x) + REGION_PAD;
  const minY = Math.min(from.p.y, to.p.y) - REGION_PAD;
  const maxY = Math.max(from.p.y, to.p.y) + REGION_PAD;
  const obstacles: Rect[] = [];
  for (const n of nodes) {
    if (n.type === "frame") continue;
    if (n.id === from.nodeId || n.id === to.nodeId) continue;
    if (n.x + n.w < minX || n.x > maxX || n.y + n.h < minY || n.y > maxY) continue;
    obstacles.push({
      x: n.x - MARGIN, y: n.y - MARGIN, w: n.w + MARGIN * 2, h: n.h + MARGIN * 2,
    });
  }
  if (!obstacles.length || !routeBlocked(plain, obstacles)) return plain;

  // Stub points just outside the endpoint nodes.
  const fs = from.side ?? dominantSide(from.p, to.p);
  const ts = to.side ?? dominantSide(to.p, from.p);
  const pStart = { x: from.p.x + SIDE_VEC[fs].x * STUB, y: from.p.y + SIDE_VEC[fs].y * STUB };
  const pEnd = { x: to.p.x + SIDE_VEC[ts].x * STUB, y: to.p.y + SIDE_VEC[ts].y * STUB };

  // Endpoints must be routable: drop obstacles that swallow them.
  const inside = (p: Point, r: Rect) =>
    p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  const usable = obstacles.filter((r) => !inside(pStart, r) && !inside(pEnd, r));

  const xs = new Set<number>([pStart.x, pEnd.x]);
  const ys = new Set<number>([pStart.y, pEnd.y]);
  for (const r of usable) {
    xs.add(r.x); xs.add(r.x + r.w);
    ys.add(r.y); ys.add(r.y + r.h);
  }
  const sortedXs = [...xs].sort((a, b) => a - b);
  const sortedYs = [...ys].sort((a, b) => a - b);

  const path = orthoAStar(pStart, sideToDir(fs), pEnd, sortedXs, sortedYs, usable);
  if (!path) return plain;
  return simplify([from.p, ...path, to.p]);
}
