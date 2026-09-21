import type { Connector, Endpoint, Node } from "@orim/schema";
import type { Point, Rect } from "./camera";

export const nodeRect = (n: Node): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

export const rectContains = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Point on `rect`'s edge, on the side facing `towards` (or a fixed side). */
export function anchorPoint(
  rect: Rect,
  side: "auto" | "n" | "s" | "e" | "w",
  towards: Point,
): Point {
  const c = rectCenter(rect);
  let resolved = side;
  if (resolved === "auto") {
    const dx = towards.x - c.x;
    const dy = towards.y - c.y;
    resolved =
      Math.abs(dx) * rect.h > Math.abs(dy) * rect.w
        ? dx > 0 ? "e" : "w"
        : dy > 0 ? "s" : "n";
  }
  switch (resolved) {
    case "n": return { x: c.x, y: rect.y };
    case "s": return { x: c.x, y: rect.y + rect.h };
    case "e": return { x: rect.x + rect.w, y: c.y };
    case "w": return { x: rect.x, y: c.y };
  }
}

export type Side = "n" | "s" | "e" | "w";

const SIDE_VEC: Record<Side, Point> = {
  n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 },
};

/** The side of `at` that faces `towards` (dominant axis). */
export function dominantSide(at: Point, towards: Point): Side {
  const dx = towards.x - at.x;
  const dy = towards.y - at.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "e" : "w") : dy > 0 ? "s" : "n";
}

/** The concrete side an anchor resolves to on a node. */
export function anchorSide(rect: Rect, anchor: "auto" | Side, towards: Point): Side {
  if (anchor !== "auto") return anchor;
  const c = rectCenter(rect);
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  return Math.abs(dx) * rect.h > Math.abs(dy) * rect.w
    ? dx > 0 ? "e" : "w"
    : dy > 0 ? "s" : "n";
}

/**
 * FigJam-style elbow route: leave each endpoint perpendicular to its side
 * with a short stub, then connect orthogonally. Corners get rounded when
 * drawn. Returns a simplified polyline including both endpoints.
 */
export function elbowRoute(
  from: Point,
  fromSide: Side | null,
  to: Point,
  toSide: Side | null,
  stub = 24,
): Point[] {
  const fs = fromSide ?? dominantSide(from, to);
  const ts = toSide ?? dominantSide(to, from);
  const fh = fs === "e" || fs === "w";
  const th = ts === "e" || ts === "w";

  // Endpoints facing each other across a small gap: shrink the stubs so the
  // route doesn't wiggle, and go straight when they're basically aligned.
  let stubF = stub;
  let stubT = stub;
  if (fh && th && fs !== ts) {
    const gap = fs === "e" ? to.x - from.x : from.x - to.x;
    if (gap > 0 && gap < stub * 2) {
      if (Math.abs(from.y - to.y) < 8) return [from, to];
      stubF = stubT = Math.max(6, gap / 2);
    }
  } else if (!fh && !th && fs !== ts) {
    const gap = fs === "s" ? to.y - from.y : from.y - to.y;
    if (gap > 0 && gap < stub * 2) {
      if (Math.abs(from.x - to.x) < 8) return [from, to];
      stubF = stubT = Math.max(6, gap / 2);
    }
  }

  const p1 = { x: from.x + SIDE_VEC[fs].x * stubF, y: from.y + SIDE_VEC[fs].y * stubF };
  const p2 = { x: to.x + SIDE_VEC[ts].x * stubT, y: to.y + SIDE_VEC[ts].y * stubT };

  let mids: Point[];
  if (fh && th) {
    const mx = (p1.x + p2.x) / 2;
    mids = [{ x: mx, y: p1.y }, { x: mx, y: p2.y }];
  } else if (!fh && !th) {
    const my = (p1.y + p2.y) / 2;
    mids = [{ x: p1.x, y: my }, { x: p2.x, y: my }];
  } else if (fh) {
    mids = [{ x: p2.x, y: p1.y }];
  } else {
    mids = [{ x: p1.x, y: p2.y }];
  }

  // Simplify: drop consecutive duplicates, then collinear middle points.
  const raw = [from, p1, ...mids, p2, to];
  const pts: Point[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) pts.push(p);
  }
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i]!;
    const c = pts[i + 1];
    if (a && c && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) continue;
    out.push(b);
  }
  return out;
}

/** Resolve a connector to its full elbow polyline. */
export function connectorRoute(
  c: Connector,
  getNode: (id: string) => Node | undefined,
): Point[] | null {
  const ref = (e: Endpoint): Point | null => {
    if ("point" in e) return e.point;
    const n = getNode(e.node);
    return n ? rectCenter(nodeRect(n)) : null;
  };
  const fromRef = ref(c.from);
  const toRef = ref(c.to);
  if (!fromRef || !toRef) return null;

  const resolve = (e: Endpoint, towards: Point): { p: Point; side: Side | null } | null => {
    if ("point" in e) return { p: e.point, side: null };
    const n = getNode(e.node);
    if (!n) return null;
    const side = anchorSide(nodeRect(n), e.anchor, towards);
    return { p: anchorPoint(nodeRect(n), side, towards), side };
  };
  const from = resolve(c.from, toRef);
  const to = resolve(c.to, fromRef);
  if (!from || !to) return null;
  return elbowRoute(from.p, from.side, to.p, to.side);
}

/** Distance from point to segment — for connector hit testing. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
  const px = a.x + t * dx - p.x;
  const py = a.y + t * dy - p.y;
  return Math.hypot(px, py);
}
