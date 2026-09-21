/**
 * Paste import: Mermaid flowcharts, Markdown outlines, or delimited grids
 * (a copy from Excel/Sheets arrives as TSV) become board objects.
 */
import type { Connector, Node, PaletteColor } from "@orim/schema";
import { parseDelimited, toGrid, type BuiltImport } from "./import-grid";

export type PasteKind = "mermaid" | "grid" | "markdown" | "text";

export interface TextBuildOpts {
  newId(): string;
  origin: { x: number; y: number };
  index: string;
}

const baseOf = (index: string) => ({ parent: null, rotation: 0, index, locked: false });

export function detectPaste(text: string): PasteKind {
  const trimmed = text.trim();
  if (/^(flowchart|graph)\s/i.test(trimmed)) return "mermaid";
  const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
  if (lines.length >= 2 && lines.every((l) => l.includes("\t"))) return "grid";
  const mdMarkers = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)/;
  if (lines.some((l) => mdMarkers.test(l))) return "markdown";
  if (
    lines.length >= 2 &&
    lines.every((l) => l.includes(",")) &&
    new Set(lines.map((l) => l.split(",").length)).size <= 2
  ) {
    return "grid";
  }
  return "text";
}

export function textToGrid(text: string) {
  return toGrid(parseDelimited(text.trim()));
}

// --- Mermaid -----------------------------------------------------------------

const ARROWS = /(-\.->|-->|---|-\.-|==>|~~~)/;

function parseMermaidNode(token: string): { id: string; label: string | null; kind: "rect" | "ellipse" | "diamond" | "pill" } | null {
  const m = /^([\w.:-]+)\s*(.*)$/.exec(token.trim());
  if (!m) return null;
  const id = m[1]!;
  const rest = m[2]!.trim();
  const unquote = (s: string) => {
    const t = s.trim();
    return (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
  };
  if (!rest) return { id, label: null, kind: "rect" };
  if (rest.startsWith("((") && rest.endsWith("))")) return { id, label: unquote(rest.slice(2, -2)), kind: "ellipse" };
  if (rest.startsWith("([") && rest.endsWith("])")) return { id, label: unquote(rest.slice(2, -2)), kind: "pill" };
  if (rest.startsWith("{") && rest.endsWith("}")) return { id, label: unquote(rest.slice(1, -1)), kind: "diamond" };
  if (rest.startsWith("[") && rest.endsWith("]")) return { id, label: unquote(rest.slice(1, -1)), kind: "rect" };
  if (rest.startsWith("(") && rest.endsWith(")")) return { id, label: unquote(rest.slice(1, -1)), kind: "pill" };
  return { id, label: null, kind: "rect" };
}

export function buildFromMermaid(text: string, opts: TextBuildOpts): BuiltImport | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  const header = /^(flowchart|graph)\s*(TD|TB|LR|RL|BT)?/i.exec(lines[0] ?? "");
  if (!header) return null;
  const dir = (header[2] ?? "TD").toUpperCase();
  const layout = dir === "LR" ? "RIGHT" : dir === "RL" ? "LEFT" : dir === "BT" ? "UP" : "DOWN";

  const base = baseOf(opts.index);
  const nodes: Node[] = [];
  const byRef = new Map<string, string>();
  const ensure = (token: string): string | null => {
    const parsed = parseMermaidNode(token);
    if (!parsed) return null;
    let id = byRef.get(parsed.id);
    if (!id) {
      id = opts.newId();
      byRef.set(parsed.id, id);
      nodes.push({
        ...base, id, type: "shape", kind: parsed.kind,
        x: opts.origin.x, y: opts.origin.y,
        w: 176, h: 60, data: {},
        text: parsed.label ?? parsed.id,
        color: parsed.kind === "diamond" ? "orange" : "blue",
        fillStyle: "solid",
      });
    } else if (parsed.label) {
      const node = nodes.find((n) => n.id === id);
      if (node && "text" in node && node.text === parsed.id) {
        (node as { text: string }).text = parsed.label;
        if (node.type === "shape") node.kind = parsed.kind;
      }
    }
    return id;
  };

  const connectors: Connector[] = [];
  for (const raw of lines.slice(1)) {
    if (/^(subgraph|end$|classDef|class |style |click |linkStyle|direction)/.test(raw)) continue;
    // `a -- label --> b` → `a -->|label| b`
    const line = raw.replace(/--\s*([^->|][^->]*?)\s*-->/g, "-->|$1|");
    const parts = line.split(ARROWS);
    if (parts.length === 1) {
      if (parts[0]!.trim()) ensure(parts[0]!);
      continue;
    }
    for (let i = 0; i + 2 < parts.length + 1; i += 2) {
      const left = parts[i]!;
      const arrow = parts[i + 1];
      let right = parts[i + 2];
      if (!arrow || right === undefined) break;
      let label = "";
      const lm = /^\|([^|]*)\|\s*(.*)$/.exec(right.trim());
      if (lm) {
        label = lm[1]!.trim();
        right = lm[2]!;
      }
      const leftIds = left.split("&").map((t) => ensure(t)).filter((x): x is string => !!x);
      const rightIds = right.split("&").map((t) => ensure(t)).filter((x): x is string => !!x);
      for (const a of leftIds) {
        for (const b of rightIds) {
          connectors.push({
            id: opts.newId(), type: "connector",
            from: { node: a, anchor: "auto" },
            to: { node: b, anchor: "auto" },
            label, style: arrow === "---" || arrow === "-.-" || arrow === "~~~" ? "line" : "arrow",
            index: opts.index, data: {},
          });
        }
      }
      // Allow chains: the right side becomes the next left side.
      parts[i + 2] = right;
    }
  }
  if (!nodes.length) return null;
  return {
    nodes, connectors, layout,
    summary: `Mermaid: ${nodes.length} nodes, ${connectors.length} edges`,
  };
}

// --- Markdown ----------------------------------------------------------------

const stripInline = (s: string): string =>
  s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();

interface MdSection {
  title: string | null;
  items: { text: string; checked: boolean | null }[];
}

export function buildFromMarkdown(text: string, opts: TextBuildOpts): BuiltImport | null {
  const sections: MdSection[] = [{ title: null, items: [] }];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      sections.push({ title: stripInline(heading[1]!), items: [] });
      continue;
    }
    const item =
      /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line) ??
      /^\s*\d+[.)]\s+()(.*)$/.exec(line);
    const current = sections[sections.length - 1]!;
    if (item) {
      current.items.push({
        text: stripInline(item[2]!),
        checked: item[1] === undefined || item[1] === "" ? null : item[1] !== " ",
      });
    } else {
      current.items.push({ text: stripInline(line), checked: null });
    }
  }
  const nonEmpty = sections.filter((s) => s.items.length);
  const total = nonEmpty.reduce((sum, s) => sum + s.items.length, 0);
  if (!total) return null;

  const base = baseOf(opts.index);
  const nodes: Node[] = [];
  const COLORS: PaletteColor[] = ["yellow", "teal", "violet", "orange", "pink", "green"];
  const STICKY_W = 180, STICKY_H = 120, GAP = 16, PAD = 24, TITLE = 40;
  const laneW = 2 * STICKY_W + GAP + PAD * 2;
  let laneX = opts.origin.x;

  nonEmpty.forEach((section, si) => {
    const framed = section.title !== null;
    const frameId = framed ? opts.newId() : null;
    const rowsNeeded = Math.ceil(section.items.length / 2);
    if (framed) {
      nodes.push({
        ...base, id: frameId!, type: "frame",
        x: laneX, y: opts.origin.y,
        w: laneW, h: TITLE + rowsNeeded * (STICKY_H + GAP) + PAD,
        data: {}, title: section.title!,
      });
    }
    section.items.forEach((item, i) => {
      nodes.push({
        ...base, id: opts.newId(), type: "sticky", parent: frameId,
        x: laneX + (framed ? PAD : 0) + (i % 2) * (STICKY_W + GAP),
        y: opts.origin.y + (framed ? TITLE : 0) + Math.floor(i / 2) * (STICKY_H + GAP),
        w: STICKY_W, h: STICKY_H, data: {},
        text: item.text,
        color: item.checked === true ? "green" : COLORS[si % COLORS.length]!,
      });
    });
    laneX += laneW + 40;
  });

  const frames = nonEmpty.filter((s) => s.title !== null).length;
  return {
    nodes, connectors: [], layout: null,
    summary: frames
      ? `Outline: ${total} stickies in ${frames} sections`
      : `Outline: ${total} stickies`,
  };
}

// --- plain text --------------------------------------------------------------

export function buildFromPlainText(text: string, opts: TextBuildOpts): BuiltImport {
  const chunks = text
    .split(/\n{2,}/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 24);
  const base = baseOf(opts.index);
  const cols = Math.max(1, Math.ceil(Math.sqrt(chunks.length)));
  const nodes: Node[] = chunks.map((chunk, i) => ({
    ...base, id: opts.newId(), type: "sticky",
    x: opts.origin.x + (i % cols) * 196,
    y: opts.origin.y + Math.floor(i / cols) * 136,
    w: 180, h: 120, data: {},
    text: chunk, color: "yellow",
  }));
  return {
    nodes, connectors: [], layout: null,
    summary: chunks.length === 1 ? "1 sticky" : `${chunks.length} stickies`,
  };
}
