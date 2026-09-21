import type { Connector, Node, NodeId } from "@orim/schema";
import {
  elbowRoute, nodeRect, routeConnector, visibleWorldRect, toScreen,
  tableColumnEdges, TABLE_ROW_H,
  type Camera, type Point, type Rect,
} from "@orim/editor";
import type { TableNode } from "@orim/schema";
import { getStroke } from "perfect-freehand";
import { PALETTE, SELECTION_COLOR, CANVAS_BG } from "./colors";

export interface PresenceState {
  clientId: number;
  name: string;
  color: string;
  cursor: Point | null;
}

export interface Scene {
  nodesSorted: readonly Node[];
  connectors: ReadonlyMap<NodeId, Connector>;
  getNode: (id: NodeId) => Node | undefined;
  camera: Camera;
  selection: ReadonlySet<NodeId>;
  connectorSelection: ReadonlySet<NodeId>;
  editingId: NodeId | null;
  presences: PresenceState[];
  /** Store revision, used to invalidate cached connector routes. */
  revision: number;
  /** Transient links (e.g. sticky ↔ source table row), drawn dashed. */
  dataLinks: { a: Point; b: Point }[];
  /** Frame timestamp; drives the data-link dash animation. */
  timestamp?: number;
  /** Node whose connector ports should be shown (hover affordance). */
  portsFor: NodeId | null;
  marquee: Rect | null;
  draftRect: Rect | null;
  draftConnector: { from: Point; to: Point } | null;
  draftInk: number[] | null;
  draftColor: string;
}

const FONT_SIZE = 15;
const TEXT_ZOOM_MIN = 0.3;
const DETAIL_ZOOM_MIN = 0.08;
const FONT_STACK = "-apple-system, system-ui, sans-serif";

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private wrapCache = new Map<NodeId, { key: string; lines: string[] }>();
  private inkCache = new Map<NodeId, { key: number; path: Path2D }>();
  private routeCache = new Map<NodeId, { rev: number; route: Point[] | null }>();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  render(scene: Scene): { visible: number } {
    const { ctx } = this;
    const { camera } = scene;
    const z = camera.zoom;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.setTransform(
      this.dpr * z, 0, 0, this.dpr * z,
      -camera.x * z * this.dpr, -camera.y * z * this.dpr,
    );

    const view = visibleWorldRect(camera, this.width, this.height);
    this.drawGrid(view, z);
    const drawText = z >= TEXT_ZOOM_MIN;
    const drawDetail = z >= DETAIL_ZOOM_MIN;
    let visible = 0;

    const inView = (n: { x: number; y: number; w: number; h: number }) =>
      !(n.x > view.maxX || n.y > view.maxY || n.x + n.w < view.minX || n.y + n.h < view.minY);

    // Pass 1: frames (always behind content).
    for (const n of scene.nodesSorted) {
      if (n.type !== "frame" || !inView(n)) continue;
      visible++;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(n.x, n.y, n.w, n.h);
      ctx.strokeStyle = scene.selection.has(n.id) ? SELECTION_COLOR : "#C7C7C2";
      ctx.lineWidth = (scene.selection.has(n.id) ? 2 : 1.25) / z;
      ctx.strokeRect(n.x, n.y, n.w, n.h);
      if (drawText) {
        ctx.fillStyle = "#6B7280";
        ctx.font = `600 13px ${FONT_STACK}`;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(n.title, n.x + 1, n.y - 8 / z);
      }
    }

    // Pass 2: content nodes in z-order.
    for (const n of scene.nodesSorted) {
      if (n.type === "frame" || !inView(n)) continue;
      visible++;

      if (!drawDetail) {
        ctx.fillStyle =
          n.type === "ink" ? "#9CA3AF" :
          n.type === "table" ? "#FFFFFF" :
          PALETTE[n.type === "text" ? "gray" : n.color].fill;
        if (n.type !== "text") ctx.fillRect(n.x, n.y, n.w, n.h);
        continue;
      }

      switch (n.type) {
        case "sticky": {
          const color = PALETTE[n.color];
          ctx.fillStyle = color.fill;
          this.path(n, "rect", 6);
          ctx.fill();
          ctx.strokeStyle = color.edge;
          ctx.lineWidth = 1 / z;
          ctx.stroke();
          if (drawText && n.id !== scene.editingId && n.text) {
            this.drawWrappedText(n.id, n.text, n, color.text, FONT_SIZE, true);
          }
          break;
        }
        case "shape": {
          const color = PALETTE[n.color];
          this.path(n, n.kind, 8);
          if (n.fillStyle !== "none") {
            ctx.fillStyle = n.fillStyle === "solid" ? color.fill : CANVAS_BG;
            ctx.fill();
          }
          ctx.strokeStyle = n.fillStyle === "outline" ? color.solid : color.edge;
          ctx.lineWidth = (n.fillStyle === "outline" ? 2 : 1) / Math.max(z, 0.25);
          ctx.stroke();
          if (drawText && n.id !== scene.editingId && n.text) {
            this.drawWrappedText(n.id, n.text, n, color.text, FONT_SIZE, true);
          }
          break;
        }
        case "text": {
          if (drawText && n.id !== scene.editingId && n.text) {
            this.drawWrappedText(n.id, n.text, n, "#1F2430", n.fontSize, false, 4);
          } else if (n.id !== scene.editingId && !n.text) {
            ctx.strokeStyle = "#D1D5DB";
            ctx.lineWidth = 1 / z;
            ctx.strokeRect(n.x, n.y, n.w, n.h);
          }
          break;
        }
        case "ink": {
          ctx.fillStyle = PALETTE[n.color].solid;
          const path = this.inkPath(n.id, n.points, n.size);
          ctx.save();
          ctx.translate(n.x, n.y);
          ctx.fill(path);
          ctx.restore();
          break;
        }
        case "table":
          this.drawTable(n, z, drawText);
          break;
      }

      if (scene.selection.has(n.id)) {
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(n.x - 2 / z, n.y - 2 / z, n.w + 4 / z, n.h + 4 / z);
      }
    }

    // Transient data-binding links: animated dashed curves with port dots,
    // so a live binding reads as "plugged in", not as a drawn line.
    if (scene.dataLinks.length) {
      const t = (scene.timestamp ?? 0) / 40;
      for (const link of scene.dataLinks) {
        const dx = link.b.x - link.a.x;
        const reach = Math.min(90, Math.max(28, Math.abs(dx) / 2));
        const dir = dx >= 0 ? 1 : -1;
        ctx.strokeStyle = "rgba(79, 124, 255, 0.65)";
        ctx.lineWidth = 1.75 / z;
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.lineDashOffset = -t / z;
        ctx.beginPath();
        ctx.moveTo(link.a.x, link.a.y);
        ctx.bezierCurveTo(
          link.a.x + dir * reach, link.a.y,
          link.b.x - dir * reach, link.b.y,
          link.b.x, link.b.y,
        );
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        // Port dots at both ends.
        for (const p of [link.a, link.b]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4 / z, 0, Math.PI * 2);
          ctx.fillStyle = "#4F7CFF";
          ctx.fill();
          ctx.lineWidth = 1.5 / z;
          ctx.strokeStyle = "#FFFFFF";
          ctx.stroke();
        }
      }
    }

    // Pass 3: connectors above content (like FigJam), so a short link
    // between adjacent nodes never disappears behind them. Routes avoid
    // crossing nodes; recomputed only when the board changes.
    for (const c of scene.connectors.values()) {
      const cached = this.routeCache.get(c.id);
      let route: Point[] | null;
      if (cached && cached.rev === scene.revision) {
        route = cached.route;
      } else {
        route = routeConnector(c, scene.getNode, scene.nodesSorted);
        this.routeCache.set(c.id, { rev: scene.revision, route });
      }
      if (!route || route.length < 2) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of route) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      if (!inView({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })) continue;
      const selected = scene.connectorSelection.has(c.id);
      this.drawConnector(route, c.style, selected ? SELECTION_COLOR : "#6B7280", 2 / z);
      if (c.label && drawText) this.connectorLabel(route, c.label);
    }

    // Resize handles for single selection.
    if (scene.selection.size === 1) {
      const [id] = scene.selection;
      const n = scene.getNode(id!);
      if (n && n.type !== "ink") {
        const r = nodeRect(n);
        const hs = 5 / z;
        ctx.fillStyle = "#FFFFFF";
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 1.5 / z;
        for (const [hx, hy] of [
          [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
        ] as const) {
          ctx.beginPath();
          ctx.rect(hx - hs, hy - hs, hs * 2, hs * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // Connector ports on the hovered node: grab one to draw a connector.
    if (scene.portsFor) {
      const n = scene.getNode(scene.portsFor);
      if (n && n.type !== "frame" && n.type !== "ink") {
        const ports = [
          { x: n.x + n.w / 2, y: n.y },
          { x: n.x + n.w / 2, y: n.y + n.h },
          { x: n.x + n.w, y: n.y + n.h / 2 },
          { x: n.x, y: n.y + n.h / 2 },
        ];
        for (const p of ports) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5 / z, 0, Math.PI * 2);
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
          ctx.lineWidth = 1.75 / z;
          ctx.strokeStyle = SELECTION_COLOR;
          ctx.stroke();
        }
      }
    }

    // Drafts.
    if (scene.draftRect) {
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.strokeRect(scene.draftRect.x, scene.draftRect.y, scene.draftRect.w, scene.draftRect.h);
      ctx.setLineDash([]);
    }
    if (scene.draftConnector) {
      const route = elbowRoute(scene.draftConnector.from, null, scene.draftConnector.to, null);
      this.drawConnector(route, "arrow", SELECTION_COLOR, 2 / z);
    }
    if (scene.draftInk && scene.draftInk.length >= 6) {
      ctx.fillStyle = scene.draftColor;
      ctx.fill(this.strokePath(scene.draftInk, 4));
    }
    if (scene.marquee) {
      ctx.fillStyle = "rgba(79, 124, 255, 0.08)";
      ctx.fillRect(scene.marquee.x, scene.marquee.y, scene.marquee.w, scene.marquee.h);
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(scene.marquee.x, scene.marquee.y, scene.marquee.w, scene.marquee.h);
    }

    // Remote cursors in screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const p of scene.presences) {
      if (!p.cursor) continue;
      const s = toScreen(camera, p.cursor);
      if (s.x < -40 || s.y < -40 || s.x > this.width + 40 || s.y > this.height + 40) continue;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + 12, s.y + 4.5);
      ctx.lineTo(s.x + 4.5, s.y + 12);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 11px ${FONT_STACK}`;
      const tw = ctx.measureText(p.name).width;
      ctx.beginPath();
      ctx.roundRect(s.x + 12, s.y + 12, tw + 10, 18, 9);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(p.name, s.x + 17, s.y + 25);
    }

    return { visible };
  }

  /** Minimap: content dots + viewport rectangle in a small side canvas. */
  renderMinimap(
    mini: HTMLCanvasElement,
    scene: Pick<Scene, "nodesSorted" | "camera">,
    bounds: Rect | null,
  ): { scale: number; offsetX: number; offsetY: number } | null {
    const ctx = mini.getContext("2d");
    if (!ctx) return null;
    const W = mini.width;
    const H = mini.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fillRect(0, 0, W, H);
    if (!bounds) return null;

    const pad = 10;
    const scale = Math.min((W - pad * 2) / Math.max(1, bounds.w), (H - pad * 2) / Math.max(1, bounds.h));
    const offsetX = pad - bounds.x * scale + ((W - pad * 2) - bounds.w * scale) / 2;
    const offsetY = pad - bounds.y * scale + ((H - pad * 2) - bounds.h * scale) / 2;

    for (const n of scene.nodesSorted) {
      ctx.fillStyle = n.type === "frame" ? "#E5E7EB" : PALETTE[n.type === "sticky" || n.type === "shape" || n.type === "ink" ? n.color : "gray"].edge;
      ctx.fillRect(
        n.x * scale + offsetX, n.y * scale + offsetY,
        Math.max(1.5, n.w * scale), Math.max(1.5, n.h * scale),
      );
    }
    const cam = scene.camera;
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      cam.x * scale + offsetX,
      cam.y * scale + offsetY,
      (window.innerWidth / cam.zoom) * scale,
      (window.innerHeight / cam.zoom) * scale,
    );
    return { scale, offsetX, offsetY };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Subtle dot grid. Spacing doubles/halves with zoom so on-screen dot
   * distance stays in a comfortable band, with the next-finer level fading
   * in as you zoom — no popping.
   */
  private drawGrid(
    view: { minX: number; minY: number; maxX: number; maxY: number },
    z: number,
  ): void {
    const { ctx } = this;
    const BASE = 32; // world units at 100%
    const TARGET_MIN = 22; // px between dots before we coarsen

    let spacing = BASE;
    while (spacing * z < TARGET_MIN) spacing *= 2;
    while (spacing * z >= TARGET_MIN * 2) spacing /= 2;

    // 0 → this level barely arrived, 1 → about to subdivide.
    const t = spacing * z / TARGET_MIN - 1;
    const r = 1.1 / z; // ~1.1px dots on screen

    const drawLevel = (step: number, alpha: number) => {
      if (alpha <= 0.004) return;
      ctx.fillStyle = `rgba(31, 36, 48, ${alpha})`;
      const x0 = Math.floor(view.minX / step) * step;
      const y0 = Math.floor(view.minY / step) * step;
      ctx.beginPath();
      for (let x = x0; x <= view.maxX; x += step) {
        for (let y = y0; y <= view.maxY; y += step) {
          ctx.rect(x - r, y - r, r * 2, r * 2);
        }
      }
      ctx.fill();
    };

    drawLevel(spacing * 2, 0.13); // coarse level, always steady
    drawLevel(spacing, 0.03 + 0.10 * t); // fine level fades in
  }

  private path(n: { x: number; y: number; w: number; h: number }, kind: string, radius: number): void {
    const { ctx } = this;
    ctx.beginPath();
    switch (kind) {
      case "ellipse":
        ctx.ellipse(n.x + n.w / 2, n.y + n.h / 2, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
        break;
      case "diamond":
        ctx.moveTo(n.x + n.w / 2, n.y);
        ctx.lineTo(n.x + n.w, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w / 2, n.y + n.h);
        ctx.lineTo(n.x, n.y + n.h / 2);
        ctx.closePath();
        break;
      case "pill":
        ctx.roundRect(n.x, n.y, n.w, n.h, Math.min(n.w, n.h) / 2);
        break;
      default:
        ctx.roundRect(n.x, n.y, n.w, n.h, radius);
    }
  }

  /** Elbow polyline with FigJam-style rounded corner joins. */
  private drawConnector(route: Point[], style: string, color: string, lineWidth: number): void {
    const { ctx } = this;
    const first = route[0]!;
    const last = route[route.length - 1]!;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < route.length - 1; i++) {
      const prev = route[i - 1]!;
      const corner = route[i]!;
      const next = route[i + 1]!;
      const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
      const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
      const radius = Math.min(10, inLen / 2, outLen / 2);
      ctx.arcTo(corner.x, corner.y, next.x, next.y, radius);
    }
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    const beforeLast = route[route.length - 2]!;
    if (style === "arrow" || style === "double") this.arrowhead(beforeLast, last, lineWidth);
    if (style === "double") this.arrowhead(route[1]!, first, lineWidth);
  }

  private drawTable(n: TableNode, z: number, drawText: boolean): void {
    const { ctx } = this;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(n.x, n.y, n.w, n.h);
    // Header band.
    ctx.fillStyle = "#F5F5F3";
    ctx.fillRect(n.x, n.y, n.w, TABLE_ROW_H);
    ctx.strokeStyle = "#D6D6D2";
    ctx.lineWidth = 1 / Math.max(z, 0.5);
    ctx.strokeRect(n.x, n.y, n.w, n.h);

    const edges = tableColumnEdges(n);
    ctx.beginPath();
    for (let c = 1; c < edges.length - 1; c++) {
      ctx.moveTo(n.x + edges[c]!, n.y);
      ctx.lineTo(n.x + edges[c]!, n.y + n.h);
    }
    const rowCount = Math.min(n.rows.length, Math.floor(n.h / TABLE_ROW_H) - 1);
    for (let r = 0; r <= rowCount; r++) {
      ctx.moveTo(n.x, n.y + (r + 1) * TABLE_ROW_H);
      ctx.lineTo(n.x + n.w, n.y + (r + 1) * TABLE_ROW_H);
    }
    ctx.stroke();

    if (!drawText) return;
    ctx.textBaseline = "middle";
    const cellText = (text: string, colStart: number, colEnd: number, y: number, bold: boolean, color: string) => {
      if (!text) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(n.x + colStart + 4, y - TABLE_ROW_H / 2, colEnd - colStart - 8, TABLE_ROW_H);
      ctx.clip();
      ctx.font = `${bold ? "600 " : ""}12.5px ${FONT_STACK}`;
      ctx.fillStyle = color;
      ctx.fillText(text, n.x + colStart + 10, y + 1);
      ctx.restore();
    };
    n.columns.forEach((col, c) => {
      cellText(col.name, edges[c]!, edges[c + 1]!, n.y + TABLE_ROW_H / 2, true, "#6B7280");
    });
    n.rows.slice(0, rowCount).forEach((row, r) => {
      const y = n.y + (r + 1) * TABLE_ROW_H + TABLE_ROW_H / 2;
      n.columns.forEach((col, c) => {
        cellText(row.cells[col.id] ?? "", edges[c]!, edges[c + 1]!, y, false, "#1F2430");
      });
    });
    // Title above, like frames.
    ctx.font = `600 13px ${FONT_STACK}`;
    ctx.fillStyle = "#6B7280";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(n.title, n.x + 1, n.y - 8 / z);
    ctx.textBaseline = "top";
  }

  /** Label pill at the route's halfway point (by path length). */
  private connectorLabel(route: Point[], label: string): void {
    const { ctx } = this;
    let total = 0;
    const lens: number[] = [];
    for (let i = 0; i < route.length - 1; i++) {
      const l = Math.hypot(route[i + 1]!.x - route[i]!.x, route[i + 1]!.y - route[i]!.y);
      lens.push(l);
      total += l;
    }
    let remaining = total / 2;
    let mid = route[0]!;
    for (let i = 0; i < lens.length; i++) {
      if (remaining <= lens[i]!) {
        const t = lens[i]! ? remaining / lens[i]! : 0;
        mid = {
          x: route[i]!.x + (route[i + 1]!.x - route[i]!.x) * t,
          y: route[i]!.y + (route[i + 1]!.y - route[i]!.y) * t,
        };
        break;
      }
      remaining -= lens[i]!;
    }
    ctx.font = `500 12px ${FONT_STACK}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#4B5563";
    ctx.textBaseline = "middle";
    ctx.fillText(label, mid.x - tw / 2, mid.y + 1);
    ctx.textBaseline = "top";
  }

  private arrowhead(from: Point, to: Point, lineWidth: number): void {
    const { ctx } = this;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = Math.max(8, lineWidth * 4) * Math.min(1, 1.2);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - size * Math.cos(angle - 0.45), to.y - size * Math.sin(angle - 0.45));
    ctx.lineTo(to.x - size * Math.cos(angle + 0.45), to.y - size * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  private drawWrappedText(
    id: NodeId,
    text: string,
    n: { x: number; y: number; w: number; h: number },
    color: string,
    fontSize: number,
    centered: boolean,
    padding = 12,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = "top";
    const lines = this.wrap(id, text, n.w - padding * 2, fontSize);
    const lineH = fontSize * 1.35;
    let ty = centered
      ? Math.max(n.y + padding, n.y + (n.h - lines.length * lineH) / 2)
      : n.y + padding;
    for (const line of lines) {
      if (ty + lineH > n.y + n.h - padding / 2) break;
      if (centered) {
        const tw = ctx.measureText(line).width;
        ctx.fillText(line, n.x + (n.w - tw) / 2, ty);
      } else {
        ctx.fillText(line, n.x + padding, ty);
      }
      ty += lineH;
    }
  }

  private wrap(id: NodeId, text: string, maxWidth: number, fontSize: number): string[] {
    const key = `${text} ${maxWidth} ${fontSize}`;
    const cached = this.wrapCache.get(id);
    if (cached && cached.key === key) return cached.lines;
    const { ctx } = this;
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    const lines: string[] = [];
    for (const raw of text.split("\n")) {
      let line = "";
      for (const word of raw.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    this.wrapCache.set(id, { key, lines });
    return lines;
  }

  private inkPath(id: NodeId, points: number[], size: number): Path2D {
    const cached = this.inkCache.get(id);
    const key = points.length * 1000 + (points[0] ?? 0) + (points[points.length - 2] ?? 0);
    if (cached && cached.key === key) return cached.path;
    const path = this.strokePath(points, size);
    this.inkCache.set(id, { key, path });
    return path;
  }

  private strokePath(flat: number[], size: number): Path2D {
    const pts: [number, number, number][] = [];
    for (let i = 0; i + 2 < flat.length + 1; i += 3) {
      pts.push([flat[i]!, flat[i + 1]!, flat[i + 2] ?? 0.5]);
    }
    const outline = getStroke(pts, { size: size * 2, thinning: 0.55, smoothing: 0.6, streamline: 0.45 });
    const path = new Path2D();
    if (!outline.length) return path;
    path.moveTo(outline[0]![0]!, outline[0]![1]!);
    for (let i = 1; i < outline.length; i++) path.lineTo(outline[i]![0]!, outline[i]![1]!);
    path.closePath();
    return path;
  }
}
