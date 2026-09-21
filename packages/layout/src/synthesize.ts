/**
 * Cluster synthesis: stickies → structured table.
 *
 * Spatial clusters (stickies whose inflated rects touch) become the
 * Cluster column; a cluster fully inside one frame takes that frame's
 * title as its name. Each sticky maps to a row, and the returned
 * bindings let the caller turn the stickies into live views of their
 * rows (`data.$source`), closing the loop: cell edits flow back to the
 * canvas and sticky edits flow into the table.
 */
import type { FrameNode, StickyNode, TableColumn, TableRow } from "@orim/schema";

const CLUSTER_GAP = 80; // stickies closer than this belong together

export interface SynthesizedTable {
  columns: TableColumn[];
  rows: TableRow[];
  /** stickyId -> its row; bind with column c0 (Item). */
  bindings: { stickyId: string; rowId: string; columnId: string }[];
}

function overlapsInflated(a: StickyNode, b: StickyNode, gap: number): boolean {
  return (
    a.x - gap < b.x + b.w && a.x + a.w + gap > b.x &&
    a.y - gap < b.y + b.h && a.y + a.h + gap > b.y
  );
}

/** Connected components over spatial proximity. */
export function clusterStickies(stickies: StickyNode[], gap = CLUSTER_GAP): StickyNode[][] {
  const clusters: StickyNode[][] = [];
  const assigned = new Set<string>();
  for (const seed of stickies) {
    if (assigned.has(seed.id)) continue;
    const cluster: StickyNode[] = [];
    const queue = [seed];
    assigned.add(seed.id);
    while (queue.length) {
      const cur = queue.pop()!;
      cluster.push(cur);
      for (const other of stickies) {
        if (!assigned.has(other.id) && overlapsInflated(cur, other, gap)) {
          assigned.add(other.id);
          queue.push(other);
        }
      }
    }
    clusters.push(cluster);
  }
  // Reading order: clusters by their top-left corner, members likewise.
  const keyOf = (c: StickyNode[]) => ({
    y: Math.min(...c.map((s) => s.y)),
    x: Math.min(...c.map((s) => s.x)),
  });
  clusters.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return Math.abs(ka.y - kb.y) > 80 ? ka.y - kb.y : ka.x - kb.x;
  });
  for (const c of clusters) {
    c.sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
  }
  return clusters;
}

export function synthesizeTable(
  stickies: StickyNode[],
  frames: FrameNode[] = [],
  gap = CLUSTER_GAP,
): SynthesizedTable {
  const clusters = clusterStickies(stickies, gap);
  const frameTitle = new Map(frames.map((f) => [f.id, f.title]));

  const columns: TableColumn[] = [
    { id: "c0", name: "Item", w: 220 },
    { id: "c1", name: "Cluster", w: 140 },
  ];
  const rows: TableRow[] = [];
  const bindings: SynthesizedTable["bindings"] = [];

  clusters.forEach((cluster, i) => {
    // A cluster fully inside one frame is named after it.
    const parents = new Set(cluster.map((s) => s.parent));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const name = (parent && frameTitle.get(parent)) || `Cluster ${i + 1}`;
    for (const sticky of cluster) {
      const rowId = `r${rows.length}`;
      rows.push({ id: rowId, cells: { c0: sticky.text, c1: name } });
      bindings.push({ stickyId: sticky.id, rowId, columnId: "c0" });
    }
  });

  return { columns, rows, bindings };
}
