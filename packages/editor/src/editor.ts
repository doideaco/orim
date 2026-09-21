import type {
  Connector, Endpoint, Node, PaletteColor, ShapeNode, TableNode,
} from "@orim/schema";
import { tableCellAt, tableHeight } from "./table-geometry";
import type { BoardStore } from "@orim/store";
import type { Camera, Point, Rect } from "./camera";
import {
  anchorPoint, connectorRoute, distToSegment, nodeRect, normalizeRect,
  rectCenter, rectContains, rectsIntersect, unionRects,
} from "./geometry";
import { routeConnector } from "./routing";

export type ToolName =
  | "select" | "hand" | "sticky" | "rect" | "ellipse" | "diamond" | "pill"
  | "text" | "frame" | "connector" | "ink" | "table" | "comment";

const SHAPE_TOOLS: Record<string, ShapeNode["kind"]> = {
  rect: "rect", ellipse: "ellipse", diamond: "diamond", pill: "pill",
};

export interface EditorHooks {
  newId(): string;
  openTextEditor(node: Node): void;
  /** Edit a table cell; rowIndex -1 is the header (renames the column). */
  openTableCell(table: TableNode, rowIndex: number, colIndex: number): void;
  /** Start a new comment thread at a node or a free point. */
  openCommentComposer(anchor: { node: string } | { point: Point }): void;
  defaultColor(): PaletteColor;
  defaultFillStyle(): ShapeNode["fillStyle"];
}

export interface PointerInfo {
  world: Point;
  screen: Point;
  shiftKey: boolean;
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

type DragState =
  | { kind: "none" }
  | { kind: "pan"; start: Point; camStart: Point }
  | { kind: "move"; origins: Map<string, Point>; start: Point; moved: boolean }
  | { kind: "marquee"; start: Point; keep: Set<string> }
  | { kind: "resize"; id: string; handle: ResizeHandle; orig: Rect }
  | { kind: "create"; start: Point }
  | { kind: "connector"; from: Endpoint; fromNode: string | null }
  | { kind: "ink"; points: number[] };

const MIN_SIZE = 24;
const STICKY_W = 180;
const STICKY_H = 120;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A node minus the base fields the editor fills in itself. */
type NodeSeed = DistributiveOmit<
  Node, "id" | "parent" | "rotation" | "index" | "locked" | "data"
>;

export class Editor {
  tool: ToolName = "select";
  readonly selection = new Set<string>();
  readonly connectorSelection = new Set<string>();

  // Transient state the renderer draws each frame.
  marquee: Rect | null = null;
  draftRect: Rect | null = null; // shape/frame being dragged out
  draftConnector: { from: Point; to: Point } | null = null;
  draftInk: number[] | null = null;
  cursorWorld: Point = { x: 0, y: 0 };
  /** Node under the cursor (select tool, not dragging) — shows its ports. */
  hoveredId: string | null = null;

  private drag: DragState = { kind: "none" };
  private clipboard: { nodes: Node[]; connectors: Connector[] } | null = null;

  constructor(
    private store: BoardStore,
    private camera: Camera,
    private hooks: EditorHooks,
  ) {}

  // --- queries ---------------------------------------------------------------

  /** Topmost node at a world point. Frame bodies don't capture clicks —
   *  only their title strip and border do, so content inside stays reachable. */
  hitNode(p: Point, opts: { frameBodies?: boolean } = {}): Node | null {
    const sorted = this.store.nodesSorted;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const n = sorted[i]!;
      if (n.type === "frame" && !opts.frameBodies) {
        if (this.hitFrameChrome(n, p)) return n;
        continue;
      }
      if (rectContains(nodeRect(n), p)) return n;
    }
    return null;
  }

  private hitFrameChrome(n: Node, p: Point): boolean {
    const t = 8 / this.camera.zoom;
    const title: Rect = { x: n.x, y: n.y - 26 / this.camera.zoom, w: n.w, h: 26 / this.camera.zoom };
    if (rectContains(title, p)) return true;
    const r = nodeRect(n);
    const inside = rectContains(r, p);
    const insideInner = rectContains(
      { x: r.x + t, y: r.y + t, w: Math.max(0, r.w - 2 * t), h: Math.max(0, r.h - 2 * t) },
      p,
    );
    return inside && !insideInner;
  }

  hitConnector(p: Point): Connector | null {
    const tolerance = 8 / this.camera.zoom;
    for (const c of this.store.connectors.values()) {
      const route = routeConnector(c, (id) => this.store.getNode(id), this.store.nodesSorted);
      if (!route) continue;
      for (let i = 0; i < route.length - 1; i++) {
        if (distToSegment(p, route[i]!, route[i + 1]!) <= tolerance) return c;
      }
    }
    return null;
  }

  /** Resize handle under a screen point (single node selection only). */
  hitHandle(screen: Point): ResizeHandle | null {
    const node = this.singleSelectedNode();
    if (!node || node.type === "ink") return null;
    const r = nodeRect(node);
    const handles: [ResizeHandle, Point][] = [
      ["nw", { x: r.x, y: r.y }],
      ["ne", { x: r.x + r.w, y: r.y }],
      ["sw", { x: r.x, y: r.y + r.h }],
      ["se", { x: r.x + r.w, y: r.y + r.h }],
    ];
    for (const [handle, world] of handles) {
      const s = {
        x: (world.x - this.camera.x) * this.camera.zoom,
        y: (world.y - this.camera.y) * this.camera.zoom,
      };
      if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 8) return handle;
    }
    return null;
  }

  /** Connector port under a screen point: edge midpoints of the hovered
   *  or single-selected node. */
  portAt(screen: Point): { nodeId: string; side: "n" | "s" | "e" | "w" } | null {
    for (const id of [this.hoveredId, this.singleSelectedNode()?.id]) {
      if (!id) continue;
      const n = this.store.getNode(id);
      if (!n || n.type === "frame" || n.type === "ink") continue;
      const ports: ["n" | "s" | "e" | "w", Point][] = [
        ["n", { x: n.x + n.w / 2, y: n.y }],
        ["s", { x: n.x + n.w / 2, y: n.y + n.h }],
        ["e", { x: n.x + n.w, y: n.y + n.h / 2 }],
        ["w", { x: n.x, y: n.y + n.h / 2 }],
      ];
      for (const [side, world] of ports) {
        const s = {
          x: (world.x - this.camera.x) * this.camera.zoom,
          y: (world.y - this.camera.y) * this.camera.zoom,
        };
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 9) return { nodeId: id, side };
      }
    }
    return null;
  }

  /** Endpoint for a world point: a node, a table row, or a free point. */
  private endpointFor(p: Point, excludeNodeId: string | null): Endpoint {
    const hit = this.hitNode(p);
    if (!hit || hit.id === excludeNodeId) return { point: p };
    if (hit.type === "table") {
      const cell = tableCellAt(hit, p);
      if (cell && cell.rowIndex >= 0) {
        const row = hit.rows[cell.rowIndex];
        if (row) return { node: hit.id, anchor: "auto", row: row.id };
      }
    }
    return { node: hit.id, anchor: "auto" };
  }

  singleSelectedNode(): Node | null {
    if (this.selection.size !== 1) return null;
    const [id] = this.selection;
    return this.store.getNode(id!) ?? null;
  }

  contentBounds(): Rect | null {
    return unionRects(this.store.nodesSorted.map(nodeRect));
  }

  // --- pointer ---------------------------------------------------------------

  pointerDown(info: PointerInfo): void {
    const { world, screen, shiftKey } = info;
    switch (this.tool) {
      case "hand":
        this.drag = { kind: "pan", start: screen, camStart: { x: this.camera.x, y: this.camera.y } };
        return;

      case "select": {
        const handle = this.hitHandle(screen);
        if (handle) {
          const node = this.singleSelectedNode()!;
          this.drag = { kind: "resize", id: node.id, handle, orig: nodeRect(node) };
          return;
        }
        // Dragging from a port starts a connector without switching tools.
        const port = this.portAt(screen);
        if (port) {
          const n = this.store.getNode(port.nodeId)!;
          const start = anchorPoint(nodeRect(n), port.side, world);
          this.drag = {
            kind: "connector",
            from: { node: port.nodeId, anchor: port.side },
            fromNode: port.nodeId,
          };
          this.draftConnector = { from: start, to: world };
          return;
        }
        const hit = this.hitNode(world);
        if (hit) {
          if (shiftKey) {
            if (this.selection.has(hit.id)) this.selection.delete(hit.id);
            else this.selection.add(hit.id);
          } else if (!this.selection.has(hit.id)) {
            this.clearSelection();
            this.selection.add(hit.id);
          }
          this.connectorSelection.clear();
          this.drag = { kind: "move", origins: this.moveOrigins(), start: world, moved: false };
          return;
        }
        const conn = this.hitConnector(world);
        if (conn) {
          this.clearSelection();
          this.connectorSelection.add(conn.id);
          this.drag = { kind: "none" };
          return;
        }
        this.drag = {
          kind: "marquee",
          start: world,
          keep: shiftKey ? new Set(this.selection) : new Set(),
        };
        if (!shiftKey) this.clearSelection();
        return;
      }

      case "sticky": {
        const node = this.makeNode({
          type: "sticky",
          x: world.x - STICKY_W / 2, y: world.y - STICKY_H / 2,
          w: STICKY_W, h: STICKY_H,
          text: "", color: this.hooks.defaultColor(), author: undefined,
        });
        this.selectOnly(node.id);
        this.tool = "select";
        this.hooks.openTextEditor(node);
        return;
      }

      case "text": {
        const node = this.makeNode({
          type: "text",
          x: world.x, y: world.y - 14, w: 280, h: 28,
          text: "", fontSize: 16,
        });
        this.selectOnly(node.id);
        this.tool = "select";
        this.hooks.openTextEditor(node);
        return;
      }

      case "rect": case "ellipse": case "diamond": case "pill":
      case "frame":
        this.drag = { kind: "create", start: world };
        return;

      case "connector": {
        const from = this.endpointFor(world, null);
        this.drag = {
          kind: "connector",
          from,
          fromNode: "node" in from ? from.node : null,
        };
        this.draftConnector = { from: world, to: world };
        return;
      }

      case "ink":
        this.drag = { kind: "ink", points: [world.x, world.y, 0.5] };
        this.draftInk = this.drag.points;
        return;

      case "comment": {
        const hit = this.hitNode(world);
        this.tool = "select";
        this.hooks.openCommentComposer(hit ? { node: hit.id } : { point: world });
        return;
      }

      case "table": {
        const columns = ["Item", "Owner", "Status"].map((name, i) => ({
          id: `c${i}`, name, w: 160,
        }));
        const rows = [0, 1, 2].map((i) => ({ id: this.hooks.newId(), cells: {} }));
        const node = this.makeNode({
          type: "table",
          x: world.x - 240, y: world.y - tableHeight(rows.length) / 2,
          w: 480, h: tableHeight(rows.length),
          title: "Table", columns, rows,
        });
        this.selectOnly(node.id);
        this.tool = "select";
        return;
      }
    }
  }

  pointerMove(info: PointerInfo): void {
    const { world, screen } = info;
    this.cursorWorld = world;
    const drag = this.drag;
    if (drag.kind === "none" && (this.tool === "select" || this.tool === "connector")) {
      const hit = this.hitNode(world);
      if (hit) {
        this.hoveredId = hit.id;
      } else if (this.hoveredId) {
        // Keep the ports up while the cursor is in the node's halo, so
        // they can actually be grabbed just outside the edge.
        const n = this.store.getNode(this.hoveredId);
        const halo = 14 / this.camera.zoom;
        if (
          !n ||
          !rectContains(
            { x: n.x - halo, y: n.y - halo, w: n.w + halo * 2, h: n.h + halo * 2 },
            world,
          )
        ) {
          this.hoveredId = null;
        }
      }
    } else if (drag.kind !== "none") {
      this.hoveredId = null;
    }
    switch (drag.kind) {
      case "pan":
        this.camera.x = drag.camStart.x - (screen.x - drag.start.x) / this.camera.zoom;
        this.camera.y = drag.camStart.y - (screen.y - drag.start.y) / this.camera.zoom;
        return;
      case "move": {
        const dx = world.x - drag.start.x;
        const dy = world.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) * this.camera.zoom < 3) return;
        drag.moved = true;
        this.store.transact(() => {
          for (const [id, origin] of drag.origins) {
            this.store.updateNode(id, { x: origin.x + dx, y: origin.y + dy });
          }
        });
        return;
      }
      case "marquee":
        this.marquee = normalizeRect(drag.start, world);
        return;
      case "resize": {
        const { orig, handle } = drag;
        let { x, y, w, h } = orig;
        if (handle.includes("e")) w = Math.max(MIN_SIZE, world.x - orig.x);
        if (handle.includes("s")) h = Math.max(MIN_SIZE, world.y - orig.y);
        if (handle.includes("w")) {
          w = Math.max(MIN_SIZE, orig.x + orig.w - world.x);
          x = orig.x + orig.w - w;
        }
        if (handle.includes("n")) {
          h = Math.max(MIN_SIZE, orig.y + orig.h - world.y);
          y = orig.y + orig.h - h;
        }
        this.store.updateNode(drag.id, { x, y, w, h });
        return;
      }
      case "create":
        this.draftRect = normalizeRect(drag.start, world);
        return;
      case "connector":
        if (this.draftConnector) this.draftConnector.to = world;
        return;
      case "ink":
        drag.points.push(world.x, world.y, 0.5);
        return;
      case "none":
        return;
    }
  }

  pointerUp(info: PointerInfo): void {
    const drag = this.drag;
    this.drag = { kind: "none" };
    switch (drag.kind) {
      case "move":
        if (drag.moved) this.reparentDropped([...drag.origins.keys()]);
        return;

      case "marquee": {
        const rect = this.marquee;
        this.marquee = null;
        if (!rect || (rect.w < 2 && rect.h < 2)) return;
        for (const id of drag.keep) this.selection.add(id);
        for (const n of this.store.nodesSorted) {
          const within =
            n.type === "frame"
              ? rectContains(rect, { x: n.x, y: n.y }) &&
                rectContains(rect, { x: n.x + n.w, y: n.y + n.h })
              : rectsIntersect(rect, nodeRect(n));
          if (within) this.selection.add(n.id);
        }
        return;
      }

      case "create": {
        const rect = this.draftRect;
        this.draftRect = null;
        const dragged = rect && (rect.w > 8 || rect.h > 8);
        const isFrame = this.tool === "frame";
        const box: Rect = dragged
          ? rect
          : isFrame
            ? { x: info.world.x - 200, y: info.world.y - 140, w: 400, h: 280 }
            : { x: info.world.x - 80, y: info.world.y - 50, w: 160, h: 100 };
        box.w = Math.max(box.w, isFrame ? 120 : MIN_SIZE);
        box.h = Math.max(box.h, isFrame ? 90 : MIN_SIZE);
        if (isFrame) {
          const frame = this.makeNode({ type: "frame", ...box, title: "Frame" });
          // A frame drawn over existing content adopts it.
          this.store.transact(() => {
            for (const n of this.store.nodesSorted) {
              if (n.type === "frame" || n.parent !== null) continue;
              if (rectContains(box, rectCenter(nodeRect(n)))) {
                this.store.updateNode(n.id, { parent: frame.id });
              }
            }
          });
          this.selectOnly(frame.id);
          this.tool = "select";
          return;
        }
        const node = this.makeNode({
          type: "shape", ...box,
          kind: SHAPE_TOOLS[this.tool] ?? "rect",
          text: "", color: this.hooks.defaultColor(),
          fillStyle: this.hooks.defaultFillStyle(),
        });
        this.selectOnly(node.id);
        this.tool = "select";
        return;
      }

      case "connector": {
        this.draftConnector = null;
        const to = this.endpointFor(info.world, drag.fromNode);
        // A connector from a point to the same point is a misclick.
        if (
          "point" in drag.from && "point" in to &&
          Math.hypot(to.point.x - drag.from.point.x, to.point.y - drag.from.point.y) < 4
        ) return;
        this.store.upsertConnector({
          id: this.hooks.newId(),
          type: "connector",
          from: drag.from,
          to,
          label: "",
          style: "arrow",
          index: this.store.topIndex(),
          data: {},
        });
        this.tool = "select";
        return;
      }

      case "ink": {
        const pts = drag.points;
        this.draftInk = null;
        if (pts.length < 6) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 3) {
          minX = Math.min(minX, pts[i]!);
          maxX = Math.max(maxX, pts[i]!);
          minY = Math.min(minY, pts[i + 1]!);
          maxY = Math.max(maxY, pts[i + 1]!);
        }
        const pad = 8;
        const rel: number[] = [];
        for (let i = 0; i < pts.length; i += 3) {
          rel.push(pts[i]! - minX + pad, pts[i + 1]! - minY + pad, pts[i + 2]!);
        }
        this.makeNode({
          type: "ink",
          x: minX - pad, y: minY - pad,
          w: maxX - minX + pad * 2, h: maxY - minY + pad * 2,
          points: rel, color: this.hooks.defaultColor(), size: 4,
        });
        return;
      }

      default:
        return;
    }
  }

  dblClick(info: PointerInfo): void {
    if (this.tool !== "select") return;
    const hit = this.hitNode(info.world);
    if (hit && hit.type === "table") {
      this.selectOnly(hit.id);
      const cell = tableCellAt(hit, info.world);
      if (cell) this.hooks.openTableCell(hit, cell.rowIndex, cell.colIndex);
      return;
    }
    if (hit && (hit.type === "sticky" || hit.type === "shape" || hit.type === "text" || hit.type === "frame")) {
      this.selectOnly(hit.id);
      this.hooks.openTextEditor(hit);
    } else if (!hit) {
      // Double-click on empty canvas: quick sticky, the most common action.
      const node = this.makeNode({
        type: "sticky",
        x: info.world.x - STICKY_W / 2, y: info.world.y - STICKY_H / 2,
        w: STICKY_W, h: STICKY_H,
        text: "", color: this.hooks.defaultColor(), author: undefined,
      });
      this.selectOnly(node.id);
      this.hooks.openTextEditor(node);
    }
  }

  // --- commands --------------------------------------------------------------

  clearSelection(): void {
    this.selection.clear();
    this.connectorSelection.clear();
  }

  selectOnly(id: string): void {
    this.clearSelection();
    this.selection.add(id);
  }

  selectAll(): void {
    this.clearSelection();
    for (const n of this.store.nodesSorted) this.selection.add(n.id);
  }

  deleteSelection(): void {
    this.store.transact(() => {
      for (const id of this.selection) this.store.deleteNode(id);
      for (const id of this.connectorSelection) this.store.deleteConnector(id);
    });
    this.clearSelection();
  }

  copySelection(): void {
    const nodes = [...this.selection]
      .map((id) => this.store.getNode(id))
      .filter((n): n is Node => !!n);
    const ids = new Set(nodes.map((n) => n.id));
    const connectors = [...this.store.connectors.values()].filter(
      (c) =>
        "node" in c.from && ids.has(c.from.node) &&
        "node" in c.to && ids.has(c.to.node),
    );
    if (nodes.length) this.clipboard = structuredClone({ nodes, connectors });
  }

  paste(offset = 24): void {
    if (!this.clipboard) return;
    const idMap = new Map<string, string>();
    this.clearSelection();
    this.store.transact(() => {
      for (const node of this.clipboard!.nodes) {
        const id = this.hooks.newId();
        idMap.set(node.id, id);
        this.store.upsertNode({
          ...structuredClone(node),
          id,
          x: node.x + offset,
          y: node.y + offset,
          parent: null,
          index: this.store.topIndex(),
        });
        this.selection.add(id);
      }
      for (const c of this.clipboard!.connectors) {
        const remap = (e: Endpoint): Endpoint =>
          "node" in e
            ? { node: idMap.get(e.node)!, anchor: e.anchor }
            : { point: { x: e.point.x + offset, y: e.point.y + offset } };
        this.store.upsertConnector({
          ...structuredClone(c),
          id: this.hooks.newId(),
          from: remap(c.from),
          to: remap(c.to),
        });
      }
    });
  }

  duplicateSelection(): void {
    this.copySelection();
    this.paste(24);
  }

  bringToFront(): void {
    this.store.transact(() => {
      for (const id of this.selection) {
        this.store.updateNode(id, { index: this.store.topIndex() });
      }
    });
  }

  setSelectionColor(color: PaletteColor): void {
    this.store.transact(() => {
      for (const id of this.selection) {
        const n = this.store.getNode(id);
        if (n && (n.type === "sticky" || n.type === "shape" || n.type === "ink")) {
          this.store.updateNode(id, { color });
        }
      }
    });
  }

  /** Convert stickies ↔ shapes and switch shape kinds, in place: id,
   *  geometry, text, color, parent and data (bindings!) all survive. */
  setSelectionShape(kind: "sticky" | ShapeNode["kind"]): void {
    this.store.transact(() => {
      for (const id of this.selection) {
        const n = this.store.getNode(id);
        if (!n || (n.type !== "sticky" && n.type !== "shape")) continue;
        if (kind === "sticky") {
          if (n.type === "sticky") continue;
          this.store.upsertNode({
            id: n.id, type: "sticky", parent: n.parent,
            x: n.x, y: n.y, w: n.w, h: n.h,
            rotation: n.rotation, index: n.index, locked: n.locked, data: n.data,
            text: n.text, color: n.color,
          });
        } else if (n.type === "shape") {
          this.store.updateNode(id, { kind });
        } else {
          this.store.upsertNode({
            id: n.id, type: "shape", parent: n.parent,
            x: n.x, y: n.y, w: n.w, h: n.h,
            rotation: n.rotation, index: n.index, locked: n.locked, data: n.data,
            kind, text: n.text, color: n.color,
            fillStyle: this.hooks.defaultFillStyle(),
          });
        }
      }
    });
  }

  setSelectionFillStyle(fillStyle: ShapeNode["fillStyle"]): void {
    this.store.transact(() => {
      for (const id of this.selection) {
        const n = this.store.getNode(id);
        if (n && n.type === "shape") this.store.updateNode(id, { fillStyle });
      }
    });
  }

  // --- internals -------------------------------------------------------------

  private makeNode(seed: NodeSeed): Node {
    const node = {
      id: this.hooks.newId(),
      parent: null,
      rotation: 0,
      index: this.store.topIndex(),
      locked: false,
      data: {},
      ...seed,
    } as Node;
    this.store.upsertNode(node);
    return node;
  }

  /** Everything that should move when the current selection moves:
   *  the selected nodes plus children of any selected frame. */
  private moveOrigins(): Map<string, Point> {
    const origins = new Map<string, Point>();
    for (const id of this.selection) {
      const n = this.store.getNode(id);
      if (!n) continue;
      origins.set(id, { x: n.x, y: n.y });
      if (n.type === "frame") {
        for (const child of this.store.childrenOf(id)) {
          if (!origins.has(child.id)) origins.set(child.id, { x: child.x, y: child.y });
        }
      }
    }
    return origins;
  }

  /** After a drop, adopt nodes into the topmost frame under their center. */
  private reparentDropped(ids: string[]): void {
    const frames = this.store.nodesSorted.filter((n) => n.type === "frame");
    this.store.transact(() => {
      for (const id of ids) {
        const n = this.store.getNode(id);
        if (!n || n.type === "frame") continue;
        const center = rectCenter(nodeRect(n));
        let parent: string | null = null;
        for (let i = frames.length - 1; i >= 0; i--) {
          if (rectContains(nodeRect(frames[i]!), center)) {
            parent = frames[i]!.id;
            break;
          }
        }
        if (n.parent !== parent) this.store.updateNode(id, { parent });
      }
    });
  }
}

export { anchorPoint, connectorRoute };
