/**
 * Miro importer: maps payloads from Miro's documented REST API (v2 —
 * GET /v2/boards/{id}/items and /connectors) onto Orim's format. Pure
 * data-in data-out, so it runs in the CLI, in tests, and anywhere else.
 *
 * Fidelity notes: sticky notes, shapes, text, frames, cards, embeds and
 * connectors map directly. Images map to labelled placeholders unless
 * the caller inlines their bytes (the CLI tries). App-specific widgets
 * (mindmap apps, tables, documents) are counted and skipped honestly.
 */
import type { Connector, Node, PaletteColor } from "@orim/schema";

export interface MiroItem {
  id: string;
  type: string;
  position?: { x?: number; y?: number; origin?: string; relativeTo?: string };
  geometry?: { width?: number; height?: number; rotation?: number };
  data?: Record<string, unknown>;
  style?: Record<string, unknown>;
  parent?: { id?: string } | null;
}

export interface MiroConnector {
  id: string;
  startItem?: { id?: string } | null;
  endItem?: { id?: string } | null;
  captions?: { content?: string }[];
}

export interface MiroImportResult {
  nodes: Node[];
  connectors: Connector[];
  /** Miro item types we could not map, with counts — surfaced, not hidden. */
  skipped: Record<string, number>;
}

/** Miro item text is HTML; boards want plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

const STICKY_COLORS: Record<string, PaletteColor> = {
  gray: "gray", black: "gray",
  light_yellow: "yellow", yellow: "yellow",
  orange: "orange",
  light_green: "green", green: "green", dark_green: "green",
  cyan: "teal",
  light_blue: "blue", blue: "blue", dark_blue: "blue",
  light_pink: "pink", pink: "pink",
  violet: "violet",
  red: "red",
};

/** Nearest Orim palette color for an arbitrary hex fill. */
export function hexToPalette(hex: string): PaletteColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "blue";
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.15) return "gray";
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 20 || h >= 330) return "red";
  if (h < 48) return "orange";
  if (h < 70) return "yellow";
  if (h < 165) return "green";
  if (h < 200) return "teal";
  if (h < 262) return "blue";
  if (h < 300) return "violet";
  return "pink";
}

const SHAPE_KINDS: Record<string, "rect" | "ellipse" | "diamond" | "pill"> = {
  rectangle: "rect", round_rectangle: "pill", square: "rect",
  circle: "ellipse", ellipse: "ellipse", oval: "ellipse",
  rhombus: "diamond", diamond: "diamond",
};

interface MapOptions {
  newId(): string;
  index: string;
  /** Inlined image data URLs by Miro item id (the CLI fills this). */
  images?: Map<string, string>;
}

export function miroToBoard(
  items: MiroItem[],
  miroConnectors: MiroConnector[],
  opts: MapOptions,
): MiroImportResult {
  const { newId, index } = opts;
  const idMap = new Map<string, string>();
  const byMiroId = new Map(items.map((i) => [i.id, i]));
  const nodes: Node[] = [];
  const skipped: Record<string, number> = {};

  /** Top-left position in Orim world space (Miro positions are centers;
   *  frame children are relative to the parent's top-left). */
  const topLeft = (item: MiroItem, w: number, h: number): { x: number; y: number } => {
    let x = item.position?.x ?? 0;
    let y = item.position?.y ?? 0;
    if (item.position?.relativeTo === "parent_top_left" && item.parent?.id) {
      const parent = byMiroId.get(item.parent.id);
      if (parent) {
        const pw = parent.geometry?.width ?? 0;
        const ph = parent.geometry?.height ?? 0;
        x += (parent.position?.x ?? 0) - pw / 2;
        y += (parent.position?.y ?? 0) - ph / 2;
      }
    }
    return { x: x - w / 2, y: y - h / 2 };
  };

  const base = (item: MiroItem, w: number, h: number) => {
    const id = newId();
    idMap.set(item.id, id);
    const { x, y } = topLeft(item, w, h);
    return {
      id, x, y, w, h,
      parent: null as string | null,
      rotation: item.geometry?.rotation ?? 0,
      index, locked: false,
      data: {} as Record<string, unknown>,
    };
  };
  const text = (item: MiroItem, field = "content"): string =>
    typeof item.data?.[field] === "string" ? stripHtml(item.data[field] as string) : "";

  // Frames first so children can attach to them.
  const ordered = [...items].sort((a, b) =>
    a.type === "frame" && b.type !== "frame" ? -1 : b.type === "frame" && a.type !== "frame" ? 1 : 0,
  );
  for (const item of ordered) {
    const w = item.geometry?.width ?? 200;
    const h = item.geometry?.height ?? 200;
    switch (item.type) {
      case "sticky_note": {
        const fill = String(item.style?.fillColor ?? "light_yellow");
        nodes.push({
          ...base(item, w, h), type: "sticky",
          text: text(item),
          color: STICKY_COLORS[fill] ?? "yellow",
          author: undefined,
        });
        break;
      }
      case "shape": {
        const fill = String(item.style?.fillColor ?? "");
        const opacity = Number(item.style?.fillOpacity ?? 1);
        nodes.push({
          ...base(item, w, h), type: "shape",
          kind: SHAPE_KINDS[String(item.data?.shape ?? "rectangle")] ?? "rect",
          text: text(item),
          color: fill ? hexToPalette(fill) : "blue",
          fillStyle: !fill || opacity === 0 ? "outline" : "solid",
        });
        break;
      }
      case "text":
        nodes.push({
          ...base(item, w, h), type: "text",
          text: text(item),
          fontSize: Number(item.style?.fontSize ?? 16) || 16,
        });
        break;
      case "frame":
        nodes.push({
          ...base(item, w, h), type: "frame",
          title: text(item, "title") || "Frame",
        });
        break;
      case "card":
      case "app_card": {
        const title = text(item, "title");
        const description = text(item, "description");
        nodes.push({
          ...base(item, w, Math.max(h, 120)), type: "sticky",
          text: description ? `${title}\n${description}` : title,
          color: "blue", author: undefined,
        });
        break;
      }
      case "image": {
        const src = opts.images?.get(item.id);
        if (src) {
          nodes.push({
            ...base(item, w, h), type: "image", src,
            alt: text(item, "title") || "Imported image",
          });
        } else {
          nodes.push({
            ...base(item, w, h), type: "shape", kind: "rect",
            text: `(image: ${text(item, "title") || "not exported"})`,
            color: "gray", fillStyle: "outline",
          });
        }
        break;
      }
      case "embed": {
        const url = typeof item.data?.url === "string" ? item.data.url : "";
        if (/^https?:\/\//.test(url)) {
          nodes.push({ ...base(item, w || 640, h || 400), type: "embed", url });
        } else {
          skipped.embed = (skipped.embed ?? 0) + 1;
        }
        break;
      }
      default:
        skipped[item.type] = (skipped[item.type] ?? 0) + 1;
    }
  }

  // Frame membership: children carry their parent frame.
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i]!;
    const mapped = idMap.get(item.id);
    if (!mapped || !item.parent?.id) continue;
    const parentMapped = idMap.get(item.parent.id);
    if (!parentMapped) continue;
    const node = nodes.find((n) => n.id === mapped);
    if (node && node.type !== "frame") node.parent = parentMapped;
  }

  const connectors: Connector[] = [];
  for (const c of miroConnectors) {
    const from = c.startItem?.id ? idMap.get(c.startItem.id) : undefined;
    const to = c.endItem?.id ? idMap.get(c.endItem.id) : undefined;
    if (!from || !to) {
      skipped.connector = (skipped.connector ?? 0) + 1;
      continue;
    }
    connectors.push({
      id: newId(), type: "connector",
      from: { node: from, anchor: "auto" },
      to: { node: to, anchor: "auto" },
      label: stripHtml(c.captions?.[0]?.content ?? ""),
      style: "arrow", index, data: {},
    });
  }

  return { nodes, connectors, skipped };
}
