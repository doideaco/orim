/**
 * Drop a CSV/TSV/Excel file on the canvas and get the right diagram:
 * org chart, dependency graph, kanban lanes, or a table — inferred from
 * the data's shape, laid out with ELK, every object carrying its source
 * row. The magic trick that makes the "canvas as database" thesis land.
 */
import type { Node } from "@orim/schema";
import {
  buildFromGrid, buildFromMarkdown, buildFromMermaid, buildFromPlainText,
  detectPaste, inferPlan, parseDelimited, textToGrid, toGrid,
  type BuiltImport, type ImportedGrid,
} from "@orim/convert";
import { cameraToFit, toWorld, type Camera, type Editor } from "@orim/editor";
import { layered, tree } from "@orim/layout";
import type { BoardStore } from "@orim/store";

interface DropDeps {
  store: BoardStore;
  editor: Editor;
  camera: Camera;
  newId(): string;
  canEdit(): boolean;
  onDone(summary: string): void;
  onError(message: string): void;
}

async function gridFromFile(file: File): Promise<ImportedGrid | null> {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xls)$/.test(name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return null;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, {
      header: 1,
      raw: false,
      defval: "",
    }) as string[][];
    return toGrid(raw.map((r) => r.map((c) => String(c ?? ""))));
  }
  if (/\.(csv|tsv|txt)$/.test(name) || file.type.includes("csv") || file.type.startsWith("text/")) {
    return toGrid(parseDelimited(await file.text()));
  }
  return null;
}

async function insertBuilt(deps: DropDeps, built: BuiltImport, sourceLabel: string): Promise<void> {
  const { store, editor, camera } = deps;
  if (built.layout) {
    const positions = built.layout === "TREE"
      ? tree(built.nodes, built.connectors)
      : await layered(built.nodes, built.connectors, {
          direction: built.layout,
          spacing: 40,
        });
    for (const n of built.nodes) {
      const p = positions.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
    }
  }
  store.transact(() => {
    for (const n of built.nodes) store.upsertNode(n);
    for (const c of built.connectors) store.upsertConnector(c);
  });
  editor.clearSelection();
  for (const n of built.nodes) editor.selection.add(n.id);
  const bounds = boundsOf(built.nodes);
  if (bounds) {
    Object.assign(camera, cameraToFit(bounds, window.innerWidth, window.innerHeight, 96));
  }
  deps.onDone(`${sourceLabel} → ${built.summary}`);
}

export function setupFileDrop(deps: DropDeps): void {
  const { store, camera } = deps;

  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });

  window.addEventListener("drop", (e) => {
    if (!deps.canEdit()) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) {
      // No file: a dragged link (from the address bar, a bookmark, another
      // tab) becomes a live embed at the drop point.
      const url = asUrl(
        e.dataTransfer?.getData("text/uri-list")?.split("\n")[0] ??
        e.dataTransfer?.getData("text/plain") ?? "",
      );
      if (url) {
        e.preventDefault();
        insertEmbed(deps, url, toWorld(camera, { x: e.clientX, y: e.clientY }));
      }
      return;
    }
    e.preventDefault();
    const origin = toWorld(camera, { x: e.clientX, y: e.clientY });
    if (file.type.startsWith("image/")) {
      void insertImage(deps, file, origin);
      return;
    }
    void (async () => {
      try {
        const grid = await gridFromFile(file);
        if (!grid || !grid.rows.length) {
          deps.onError(`Couldn't read ${file.name} — drop a CSV, TSV or Excel file.`);
          return;
        }
        const built = buildFromGrid(grid, inferPlan(grid), {
          newId: deps.newId,
          origin,
          index: store.topIndex(),
          title: file.name.replace(/\.[^.]+$/, ""),
        });
        await insertBuilt(deps, built, file.name);
      } catch (err) {
        console.error("import failed", err);
        deps.onError(`Import of ${file.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    })();
  });
}

/**
 * A dropped or pasted image becomes an image node. Bitmaps live in the
 * document as data URLs (local-first, air-gap safe), so big files are
 * downscaled to keep boards portable.
 */
const IMAGE_MAX_EDGE = 1600;
const IMAGE_MAX_BYTES = 1_500_000;

async function imageToDataUrl(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNG keeps transparency; everything else compresses better as JPEG.
  const url = file.type === "image/png" || file.type === "image/svg+xml"
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", 0.85);
  if (url.length <= IMAGE_MAX_BYTES) return url;
  const jpeg = canvas.toDataURL("image/jpeg", 0.7);
  return jpeg.length <= IMAGE_MAX_BYTES ? jpeg : null;
}

async function insertImage(
  deps: DropDeps,
  file: File,
  at: { x: number; y: number },
): Promise<void> {
  const src = await imageToDataUrl(file);
  if (!src) {
    deps.onError(`Couldn't add ${file.name} — unreadable or too large even after downscaling.`);
    return;
  }
  const probe = new Image();
  probe.src = src;
  await probe.decode().catch(() => { /* draw anyway */ });
  const natural = { w: probe.naturalWidth || 480, h: probe.naturalHeight || 320 };
  const scale = Math.min(1, 480 / natural.w, 480 / natural.h);
  const node: Node = {
    id: deps.newId(), type: "image", parent: null,
    x: at.x - (natural.w * scale) / 2, y: at.y - (natural.h * scale) / 2,
    w: Math.max(24, natural.w * scale), h: Math.max(24, natural.h * scale),
    rotation: 0, index: deps.store.topIndex(), locked: false, data: {},
    src, alt: file.name.replace(/\.[^.]+$/, ""),
  };
  deps.store.upsertNode(node);
  deps.editor.selectOnly(node.id);
  deps.onDone(`Added image ${file.name}`);
}

/** A single pasted/dropped http(s) URL becomes a live embed node. */
const asUrl = (text: string): string | null => {
  const t = text.trim();
  return /^https?:\/\/\S+$/.test(t) && !t.includes("\n") ? t : null;
};

function insertEmbed(deps: DropDeps, url: string, at: { x: number; y: number }): void {
  const { store, editor } = deps;
  const node: Node = {
    id: deps.newId(), type: "embed", parent: null,
    x: at.x - 320, y: at.y - 200, w: 640, h: 400,
    rotation: 0, index: store.topIndex(), locked: false, data: {},
    url,
  };
  store.upsertNode(node);
  editor.selectOnly(node.id);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch { /* keep full url */ }
  deps.onDone(`Embedded ${host} — double-click to interact`);
}

/** Marker written to the system clipboard when board objects are copied,
 *  so paste can tell internal object-paste from external content. */
export const ORIM_CLIP_MARKER = "‹orim-internal-clipboard›";

export function setupPaste(
  deps: DropDeps & {
    isEditing(): boolean;
    internalPaste(): void;
    /** Load serialized board objects copied in another board/tab. */
    loadClipboard(json: string): boolean;
  },
): void {
  const { store, camera } = deps;
  window.addEventListener("paste", (e) => {
    if (deps.isEditing()) return;
    // A pasted/copied image (screenshot, image from another app).
    const imageItem = [...(e.clipboardData?.items ?? [])]
      .find((item) => item.type.startsWith("image/"));
    const imageFile = imageItem?.getAsFile();
    if (imageFile && deps.canEdit()) {
      e.preventDefault();
      void insertImage(deps, imageFile, toWorld(camera, {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }));
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    if (!text.trim() || text.startsWith(ORIM_CLIP_MARKER)) {
      // Board objects: the payload after the marker makes paste work
      // across boards; same-board paste falls back to the live buffer.
      const payload = text.slice(ORIM_CLIP_MARKER.length);
      if (payload) deps.loadClipboard(payload);
      deps.internalPaste();
      return;
    }
    const url = asUrl(text);
    if (url) {
      insertEmbed(deps, url, toWorld(camera, {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }));
      return;
    }
    void (async () => {
      try {
        const origin = toWorld(camera, {
          x: window.innerWidth / 2 - 200,
          y: window.innerHeight / 2 - 150,
        });
        const opts = { newId: deps.newId, origin, index: store.topIndex() };
        const kind = detectPaste(text);
        let built: BuiltImport | null = null;
        if (kind === "mermaid") built = buildFromMermaid(text, opts);
        if (!built && kind === "grid") {
          const grid = textToGrid(text);
          if (grid.headers.length >= 2 && grid.rows.length >= 1) {
            built = buildFromGrid(grid, inferPlan(grid), { ...opts, title: "Pasted data" });
          }
        }
        if (!built && (kind === "markdown" || kind === "mermaid")) {
          built = buildFromMarkdown(text, opts);
        }
        if (!built) built = buildFromPlainText(text, opts);
        await insertBuilt(deps, built, "Pasted");
      } catch (err) {
        console.error("paste import failed", err);
        deps.onError(`Paste failed: ${err instanceof Error ? err.message : err}`);
      }
    })();
  });
}

function boundsOf(nodes: Node[]) {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
