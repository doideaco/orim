/**
 * Board → standalone SVG. Mirrors the canvas renderer's output closely
 * enough to be the canonical vector export (and the source for PNG).
 * Text wrapping is estimated (no canvas measurement here) so this also
 * runs in Node — e.g. from the MCP server.
 */
import type { Connector, Node } from "@orim/schema";
import {
  routeConnector, unionRects, nodeRect, tableColumnEdges, TABLE_ROW_H, type Point,
} from "@orim/editor";
import { PALETTE, CANVAS_BG } from "@orim/renderer";
import { getStroke } from "perfect-freehand";
import type { ExportBoard } from "./order";

const FONT = "-apple-system, system-ui, 'Segoe UI', sans-serif";
const FONT_SIZE = 15;
const CHAR_W = 0.52; // average glyph width as a fraction of font size

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * CHAR_W)));
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function textBlock(
  n: { x: number; y: number; w: number; h: number },
  text: string,
  color: string,
  fontSize: number,
  centered: boolean,
  padding = 12,
): string {
  const lines = wrap(text, n.w - padding * 2, fontSize);
  const lineH = fontSize * 1.35;
  const startY = centered
    ? Math.max(n.y + padding, n.y + (n.h - lines.length * lineH) / 2)
    : n.y + padding;
  const parts: string[] = [];
  lines.forEach((line, i) => {
    const y = startY + i * lineH + fontSize * 0.8;
    if (y > n.y + n.h - 2) return;
    const anchor = centered ? ` x="${n.x + n.w / 2}" text-anchor="middle"` : ` x="${n.x + padding}"`;
    parts.push(`<text${anchor} y="${y}" font-family="${FONT}" font-size="${fontSize}" fill="${color}">${esc(line)}</text>`);
  });
  return parts.join("\n");
}

function pathFrom(points: Point[], radius = 10): string {
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const inV = { x: (corner.x - prev.x) / inLen, y: (corner.y - prev.y) / inLen };
    const outV = { x: (next.x - corner.x) / outLen, y: (next.y - corner.y) / outLen };
    d += ` L ${corner.x - inV.x * r} ${corner.y - inV.y * r}`;
    d += ` Q ${corner.x} ${corner.y} ${corner.x + outV.x * r} ${corner.y + outV.y * r}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function arrowhead(from: Point, to: Point, color: string): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 8;
  const p = (a: number) =>
    `${to.x - size * Math.cos(angle + a)},${to.y - size * Math.sin(angle + a)}`;
  return `<polygon points="${to.x},${to.y} ${p(-0.45)} ${p(0.45)}" fill="${color}" />`;
}

export function boardToSVG(board: ExportBoard): string {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const getNode = (id: string) => byId.get(id);
  const bounds = unionRects(board.nodes.map(nodeRect)) ?? { x: 0, y: 0, w: 800, h: 600 };
  const pad = 48;
  const parts: string[] = [];

  const zSorted = [...board.nodes].sort((a, b) =>
    a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1,
  );

  // Frames behind everything.
  for (const n of zSorted) {
    if (n.type !== "frame") continue;
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="#FFFFFF" stroke="#C7C7C2" stroke-width="1.25" />`);
    parts.push(`<text x="${n.x + 1}" y="${n.y - 8}" font-family="${FONT}" font-size="13" font-weight="600" fill="#6B7280">${esc(n.title)}</text>`);
  }

  for (const n of zSorted) {
    switch (n.type) {
      case "sticky": {
        const c = PALETTE[n.color];
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="${c.fill}" stroke="${c.edge}" />`);
        if (n.text) parts.push(textBlock(n, n.text, c.text, FONT_SIZE, true));
        break;
      }
      case "shape": {
        const c = PALETTE[n.color];
        const fill = n.fillStyle === "solid" ? c.fill : n.fillStyle === "outline" ? CANVAS_BG : "none";
        const stroke = n.fillStyle === "outline" ? c.solid : c.edge;
        const sw = n.fillStyle === "outline" ? 2 : 1;
        const attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`;
        if (n.kind === "ellipse") {
          parts.push(`<ellipse cx="${n.x + n.w / 2}" cy="${n.y + n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}" ${attrs} />`);
        } else if (n.kind === "diamond") {
          parts.push(`<polygon points="${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}" ${attrs} />`);
        } else {
          const rx = n.kind === "pill" ? Math.min(n.w, n.h) / 2 : 8;
          parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" ${attrs} />`);
        }
        if (n.text) parts.push(textBlock(n, n.text, c.text, FONT_SIZE, true));
        break;
      }
      case "text":
        if (n.text) parts.push(textBlock(n, n.text, "#1F2430", n.fontSize, false, 4));
        break;
      case "table": {
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="#FFFFFF" stroke="#D6D6D2" />`);
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${TABLE_ROW_H}" fill="#F5F5F3" />`);
        const edges = tableColumnEdges(n);
        for (let c = 1; c < edges.length - 1; c++) {
          parts.push(`<line x1="${n.x + edges[c]!}" y1="${n.y}" x2="${n.x + edges[c]!}" y2="${n.y + n.h}" stroke="#D6D6D2" />`);
        }
        const visibleRows = Math.min(n.rows.length, Math.floor(n.h / TABLE_ROW_H) - 1);
        for (let r = 0; r <= visibleRows; r++) {
          const y = n.y + (r + 1) * TABLE_ROW_H;
          parts.push(`<line x1="${n.x}" y1="${y}" x2="${n.x + n.w}" y2="${y}" stroke="#D6D6D2" />`);
        }
        const cellText = (s: string, colStart: number, colEnd: number, y: number, bold: boolean) => {
          if (!s) return;
          const maxChars = Math.max(3, Math.floor((colEnd - colStart - 16) / (12.5 * CHAR_W)));
          parts.push(`<text x="${n.x + colStart + 10}" y="${y + 4.5}" font-family="${FONT}" font-size="12.5"${bold ? ' font-weight="600"' : ""} fill="${bold ? "#6B7280" : "#1F2430"}">${esc(s.replace(/\n/g, " ").slice(0, maxChars))}</text>`);
        };
        n.columns.forEach((col, c) => cellText(col.name, edges[c]!, edges[c + 1]!, n.y + TABLE_ROW_H / 2, true));
        n.rows.slice(0, visibleRows).forEach((row, r) => {
          const y = n.y + (r + 1) * TABLE_ROW_H + TABLE_ROW_H / 2;
          n.columns.forEach((col, c) => cellText(row.cells[col.id] ?? "", edges[c]!, edges[c + 1]!, y, false));
        });
        parts.push(`<text x="${n.x + 1}" y="${n.y - 8}" font-family="${FONT}" font-size="13" font-weight="600" fill="#6B7280">${esc(n.title)}</text>`);
        break;
      }
      case "image": {
        // Data-URL images embed directly; SVG stays self-contained.
        parts.push(
          `<image x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" ` +
          `href="${n.src}" preserveAspectRatio="none"><title>${esc(n.alt)}</title></image>`,
        );
        break;
      }
      case "embed": {
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="#FFFFFF" stroke="#C7C7C2" />`);
        parts.push(`<text x="${n.x + 10}" y="${n.y + 24}" font-family="${FONT}" font-size="13" fill="#6B7280">${esc(n.url)}</text>`);
        break;
      }
      case "ink": {
        const pts: [number, number, number][] = [];
        for (let i = 0; i + 1 < n.points.length; i += 3) {
          pts.push([n.x + n.points[i]!, n.y + n.points[i + 1]!, n.points[i + 2] ?? 0.5]);
        }
        const outline = getStroke(pts, { size: n.size * 2, thinning: 0.55, smoothing: 0.6, streamline: 0.45 });
        if (outline.length) {
          const d = `M ${outline.map((p) => `${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)}`).join(" L ")} Z`;
          parts.push(`<path d="${d}" fill="${PALETTE[n.color].solid}" />`);
        }
        break;
      }
    }
  }

  // Connectors above content, matching the canvas renderer.
  for (const c of board.connectors) {
    const route = routeConnector(c as Connector, getNode, board.nodes);
    if (!route || route.length < 2) continue;
    parts.push(`<path d="${pathFrom(route)}" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" />`);
    const last = route[route.length - 1]!;
    const beforeLast = route[route.length - 2]!;
    if (c.style === "arrow" || c.style === "double") parts.push(arrowhead(beforeLast, last, "#6B7280"));
    if (c.style === "double") parts.push(arrowhead(route[1]!, route[0]!, "#6B7280"));
    if (c.label) {
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
      const tw = c.label.length * 12 * CHAR_W;
      const w = tw + 20;
      if (total < w + 44) mid = { x: mid.x, y: mid.y - 20 };
      parts.push(`<rect x="${mid.x - w / 2}" y="${mid.y - 12}" width="${w}" height="24" rx="12" fill="#FFFFFF" stroke="rgba(0,0,0,0.08)" />`);
      parts.push(`<text x="${mid.x}" y="${mid.y + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="500" fill="#374151">${esc(c.label)}</text>`);
    }
  }

  const vb = `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${bounds.w + pad * 2}" height="${bounds.h + pad * 2}">`,
    `<rect x="${bounds.x - pad}" y="${bounds.y - pad}" width="${bounds.w + pad * 2}" height="${bounds.h + pad * 2}" fill="${CANVAS_BG}" />`,
    ...parts,
    `</svg>`,
  ].join("\n");
}
