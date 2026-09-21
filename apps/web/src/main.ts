import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { BoardStore } from "@orim/store";
import { cellSource, type PaletteColor } from "@orim/schema";
import {
  Editor, cameraToFit, tableCellRect, toScreen, toWorld, zoomAt,
  type Camera, type ToolName,
} from "@orim/editor";
import {
  Renderer, PALETTE, PALETTE_KEYS, CURSOR_COLORS, type PresenceState,
} from "@orim/renderer";
import {
  boardToJSON, boardToMarkdown, boardToMermaid, boardToSVG, type ExportBoard,
} from "@orim/convert";
import { TextEditorOverlay, isEditable } from "./editor-overlay";
import { DataPanel } from "./data-panel";
import { A11yMirror } from "./a11y-mirror";
import { ORIM_CLIP_MARKER, setupFileDrop, setupPaste } from "./import-drop";
import { CommentsUI } from "./comments-ui";
import {
  createElement, MousePointer2, Hand, StickyNote, Square, Circle, Diamond,
  Type, Frame, MoveUpRight, Pencil, Download, Table, RectangleHorizontal,
  MessageCircle, type IconNode,
} from "lucide";

// Board id comes from the URL (?b=my-board), so a link IS a share link.
const BOARD = `orim-${new URLSearchParams(location.search).get("b") ?? "main"}`;

// --- state -------------------------------------------------------------------

const doc = new Y.Doc();
new IndexeddbPersistence(BOARD, doc); // offline-first: local before network
const store = new BoardStore(doc);
const camera: Camera = { x: -80, y: -80, zoom: 1 };
let presences: PresenceState[] = [];
let defaultColor: PaletteColor = "yellow";
let defaultFillStyle: "solid" | "outline" | "none" = "solid";
let dirty = true;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const overlay = new TextEditorOverlay(document.getElementById("overlay-root")!);
const minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let nextId = 0;
const newId = () =>
  `${doc.clientID.toString(36)}-${(nextId++).toString(36)}-${Date.now().toString(36)}`;

const editor = new Editor(store, camera, {
  newId,
  defaultColor: () => defaultColor,
  defaultFillStyle: () => defaultFillStyle,
  openTableCell: (table, rowIndex, colIndex) => openTableCellEditor(table, rowIndex, colIndex),
  openCommentComposer: (anchor) => {
    comments.compose(anchor);
    dirty = true;
  },
  openTextEditor: (node) => {
    if (node.type === "frame") {
      openFrameTitleEditor(node);
    } else if (isEditable(node)) {
      overlay.open(node, camera, (text) => commitNodeText(node, text));
    }
    dirty = true;
  },
});

/** Text commit with cell-binding write-through: a bound node writes to
 *  its source cell and the reconciler updates every bound view. */
function commitNodeText(node: import("@orim/schema").Node, text: string): void {
  const src = cellSource(node);
  const table = src ? store.getNode(src.table) : undefined;
  if (src && table?.type === "table") {
    store.updateNode(src.table, {
      rows: table.rows.map((r) =>
        r.id === src.row ? { ...r, cells: { ...r.cells, [src.column]: text } } : r,
      ),
    });
  } else {
    store.updateNode(node.id, { text });
  }
}

function openFrameTitleEditor(frame: { id: string; x: number; y: number; title: string }): void {
  const s = toScreen(camera, { x: frame.x, y: frame.y - 26 / camera.zoom });
  const input = document.createElement("input");
  input.value = frame.title;
  input.style.cssText = `position:absolute; left:${s.x}px; top:${s.y}px; width:220px;
    pointer-events:auto; font:600 13px -apple-system,system-ui,sans-serif; color:#374151;
    padding:2px 6px; border:none; border-radius:5px; outline:2px solid var(--accent); background:#fff;`;
  document.getElementById("overlay-root")!.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    if (input.value.trim()) store.updateNode(frame.id, { title: input.value.trim() });
    input.remove();
    dirty = true;
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = frame.title;
      input.blur();
    }
  });
}

const dataPanel = new DataPanel(store, editor, camera, () => {
  dirty = true;
});

const comments = new CommentsUI(store, camera, () => me.name, () => {
  dirty = true;
});

const a11y = new A11yMirror(store, editor, camera, {
  onChange: () => {
    dirty = true;
    dataPanel.scheduleRefresh();
  },
  openEditor: (node) => {
    if (node.type === "frame") openFrameTitleEditor(node);
    else if (isEditable(node)) {
      overlay.open(node, camera, (text) => commitNodeText(node, text));
      dirty = true;
    }
  },
  overlayRoot: document.getElementById("overlay-root")!,
});

function openTableCellEditor(
  table: import("@orim/schema").TableNode,
  rowIndex: number,
  colIndex: number,
): void {
  const cell = tableCellRect(table, rowIndex, colIndex);
  const s = toScreen(camera, cell);
  const col = table.columns[colIndex]!;
  const isHeader = rowIndex === -1;
  const row = isHeader ? null : table.rows[rowIndex]!;
  const input = document.createElement("input");
  input.value = isHeader ? col.name : row!.cells[col.id] ?? "";
  input.style.cssText = `position:absolute; left:${s.x}px; top:${s.y}px;
    width:${cell.w * camera.zoom}px; height:${cell.h * camera.zoom}px;
    pointer-events:auto; font:${isHeader ? "600 " : ""}12.5px -apple-system,system-ui,sans-serif;
    color:#1f2430; padding:0 10px; border:none; outline:2px solid var(--accent);
    background:#fff; box-sizing:border-box;`;
  document.getElementById("overlay-root")!.appendChild(input);
  input.focus();
  input.select();
  let cancelled = false;
  const commit = () => {
    if (!cancelled) {
      const value = input.value;
      const live = store.getNode(table.id);
      if (live?.type === "table") {
        if (isHeader) {
          store.updateNode(table.id, {
            columns: live.columns.map((c) => (c.id === col.id ? { ...c, name: value } : c)),
          });
        } else {
          store.updateNode(table.id, {
            rows: live.rows.map((r) =>
              r.id === row!.id ? { ...r, cells: { ...r.cells, [col.id]: value } } : r,
            ),
          });
        }
      }
    }
    input.remove();
    dirty = true;
    dataPanel.scheduleRefresh();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      cancelled = true;
      input.blur();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      input.blur();
      const live = store.getNode(table.id);
      if (live?.type === "table") {
        const nextCol = (colIndex + 1) % live.columns.length;
        const nextRow = nextCol === 0 && !isHeader ? Math.min(rowIndex + 1, live.rows.length - 1) : rowIndex;
        openTableCellEditor(live, nextRow, nextCol);
      }
    }
  });
}

// --- file drop → diagram -----------------------------------------------------

let toastTimer: number | null = null;
function toast(message: string, isError = false): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 4200);
}

const importDeps = {
  store, editor, camera, newId,
  onDone: (summary: string) => {
    toast(summary);
    dirty = true;
    dataPanel.scheduleRefresh();
  },
  onError: (message: string) => toast(message, true),
};
setupFileDrop(importDeps);
setupPaste({
  ...importDeps,
  isEditing: () => {
    if (overlay.activeId) return true;
    const t = document.activeElement;
    return (
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    );
  },
  internalPaste: () => {
    editor.paste();
    dirty = true;
    dataPanel.scheduleRefresh();
  },
});

// --- sync --------------------------------------------------------------------

const provider = new HocuspocusProvider({
  url: "ws://localhost:1234",
  name: BOARD,
  document: doc,
  onStatus: ({ status }) => {
    $("stat-conn").textContent = status === "connected" ? "synced" : status;
    $("status-dot").classList.toggle("connected", status === "connected");
  },
});

const me = {
  name: `Guest-${Math.floor(Math.random() * 900 + 100)}`,
  color: CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]!,
};
const awareness = provider.awareness;
awareness?.setLocalState({ ...me, cursor: null });
awareness?.on("change", () => {
  presences = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    if (state && typeof state.name === "string") {
      presences.push({
        clientId,
        name: state.name,
        color: typeof state.color === "string" ? state.color : "#888",
        cursor: state.cursor ?? null,
      });
    }
  });
  dirty = true;
});

store.subscribe(() => {
  dirty = true;
  dataPanel.scheduleRefresh();
  comments.refresh();
  reconcileDerived();
});

/** Cell-bound nodes always show their source cell's current text. */
let reconciling = false;
function reconcileDerived(): void {
  if (reconciling) return;
  reconciling = true;
  try {
    const updates: [string, string][] = [];
    for (const n of store.nodes.values()) {
      const src = cellSource(n);
      if (!src || !("text" in n)) continue;
      const table = store.getNode(src.table);
      if (table?.type !== "table") continue;
      const row = table.rows.find((r) => r.id === src.row);
      if (!row) continue;
      const text = row.cells[src.column] ?? "";
      if (text !== n.text) updates.push([n.id, text]);
    }
    if (updates.length) {
      store.transact(() => {
        for (const [id, text] of updates) store.updateNode(id, { text });
      });
    }
  } finally {
    reconciling = false;
  }
}

/** Dashed setup links between selected bound nodes and their source rows. */
function computeDataLinks(): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  if (!editor.selection.size) return [];
  const links: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  for (const n of store.nodes.values()) {
    const src = cellSource(n);
    if (!src) continue;
    if (!editor.selection.has(n.id) && !editor.selection.has(src.table)) continue;
    const table = store.getNode(src.table);
    if (table?.type !== "table") continue;
    const rowIndex = table.rows.findIndex((r) => r.id === src.row);
    if (rowIndex < 0) continue;
    const rowY = table.y + (rowIndex + 1.5) * 34;
    const nodeLeftOfTable = n.x + n.w < table.x;
    links.push({
      a: { x: nodeLeftOfTable ? table.x : table.x + table.w, y: rowY },
      b: { x: nodeLeftOfTable ? n.x + n.w : n.x, y: n.y + n.h / 2 },
    });
  }
  return links;
}

// --- pointer -----------------------------------------------------------------

const info = (e: PointerEvent | MouseEvent) => ({
  world: toWorld(camera, { x: e.clientX, y: e.clientY }),
  screen: { x: e.clientX, y: e.clientY },
  shiftKey: e.shiftKey,
});

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (editor.tool === "select") {
    const pin = comments.pinAt({ x: e.clientX, y: e.clientY });
    if (pin) {
      comments.open(pin.id);
      dirty = true;
      return;
    }
  }
  if (overlay.activeId) {
    const hit = editor.hitNode(toWorld(camera, { x: e.clientX, y: e.clientY }));
    if (hit?.id === overlay.activeId) return;
    overlay.close(true);
  }
  canvas.setPointerCapture(e.pointerId);
  editor.pointerDown(info(e));
  dirty = true;
});

canvas.addEventListener("pointermove", (e) => {
  const i = info(e);
  awareness?.setLocalStateField("cursor", i.world);
  editor.pointerMove(i);
  canvas.style.cursor = editor.portAt(i.screen) ? "crosshair" : "";
  dirty = true;
});

canvas.addEventListener("pointerup", (e) => {
  editor.pointerUp(info(e));
  syncToolbar();
  dirty = true;
  dataPanel.scheduleRefresh();
  a11y.scheduleRebuild();
});

canvas.addEventListener("dblclick", (e) => {
  editor.dblClick(info(e));
  dirty = true;
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const next = zoomAt(camera, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.01));
      Object.assign(camera, next);
    } else {
      camera.x += e.deltaX / camera.zoom;
      camera.y += e.deltaY / camera.zoom;
    }
    dirty = true;
  },
  { passive: false },
);

// --- keyboard ----------------------------------------------------------------

const TOOL_KEYS: Record<string, ToolName> = {
  v: "select", h: "hand", n: "sticky", r: "rect", o: "ellipse",
  d: "diamond", t: "text", f: "frame", c: "connector", p: "ink", g: "table",
  m: "comment",
};

window.addEventListener("keydown", (e) => {
  if (overlay.activeId) return; // ProseMirror owns the keyboard while editing
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) {
    return; // form fields (data panel, frame rename) own their keys
  }
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mod) {
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) store.undo.redo();
      else store.undo.undo();
    } else if (key === "a") {
      e.preventDefault();
      editor.selectAll();
    } else if (key === "c") {
      e.preventDefault();
      editor.copySelection();
      // Mark the system clipboard so paste knows to use the internal buffer.
      void navigator.clipboard?.writeText(ORIM_CLIP_MARKER).catch(() => {});
    } else if (key === "d") {
      e.preventDefault();
      editor.duplicateSelection();
    } else if (key === "]") {
      e.preventDefault();
      editor.bringToFront();
    }
    dirty = true;
    return;
  }

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    editor.deleteSelection();
  } else if (e.key === "Escape") {
    editor.clearSelection();
    editor.tool = "select";
  } else if (key === "1") {
    zoomToFit();
  } else if (key === "0") {
    camera.zoom = 1;
  } else if (key === "\\") {
    dataPanel.toggle();
  } else if (TOOL_KEYS[key]) {
    editor.tool = TOOL_KEYS[key]!;
  }
  syncToolbar();
  dirty = true;
  dataPanel.scheduleRefresh();
});

window.addEventListener("resize", () => {
  renderer.resize();
  dirty = true;
});

// --- toolbar -----------------------------------------------------------------

const TOOL_ICONS: Record<string, IconNode> = {
  select: MousePointer2, hand: Hand, sticky: StickyNote, rect: Square,
  ellipse: Circle, diamond: Diamond, text: Type, frame: Frame,
  connector: MoveUpRight, ink: Pencil, table: Table, comment: MessageCircle,
};

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>("#toolbar [data-tool]")];
for (const btn of toolButtons) {
  const icon = TOOL_ICONS[btn.dataset.tool!];
  if (icon) {
    btn.appendChild(
      createElement(icon, { width: 19, height: 19, "stroke-width": 1.75 }),
    );
  }
  btn.addEventListener("click", () => {
    editor.tool = btn.dataset.tool as ToolName;
    syncToolbar();
  });
}

function syncToolbar(): void {
  for (const btn of toolButtons) {
    const active = btn.dataset.tool === editor.tool;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

// Buttons that only show an icon or a glyph still need a name.
for (const btn of document.querySelectorAll<HTMLElement>("button[title]")) {
  if (!btn.getAttribute("aria-label")) btn.setAttribute("aria-label", btn.title);
}

// One swatch shows the active fill + stroke; clicking opens the popover.
const swatchBtn = $("swatch");
const swatchChip = swatchBtn.querySelector(".chip") as HTMLElement;
const popover = $("color-popover");
const swatchesEl = $("popover-swatches");
const fillStylesEl = $("popover-fillstyles");

function refreshSwatchUI(): void {
  const c = PALETTE[defaultColor];
  swatchChip.style.background =
    defaultFillStyle === "solid" ? c.fill : defaultFillStyle === "outline" ? "#fff" : "transparent";
  swatchChip.style.borderColor = defaultFillStyle === "outline" ? c.solid : c.edge;
  for (const b of swatchesEl.children) {
    b.classList.toggle("active", (b as HTMLElement).dataset.color === defaultColor);
  }
  for (const b of fillStylesEl.children) {
    b.classList.toggle("active", (b as HTMLElement).dataset.fill === defaultFillStyle);
  }
  // Shape segment reflects the selected object, when there is one.
  const sel = editor.singleSelectedNode();
  const kind = sel?.type === "sticky" ? "sticky" : sel?.type === "shape" ? sel.kind : null;
  for (const b of $("popover-shapes").children) {
    b.classList.toggle("active", (b as HTMLElement).dataset.kind === kind);
  }
}

for (const key of PALETTE_KEYS) {
  const btn = document.createElement("button");
  btn.dataset.color = key;
  btn.title = key;
  btn.style.background = PALETTE[key].fill;
  btn.style.borderColor = PALETTE[key].edge;
  btn.addEventListener("click", () => {
    defaultColor = key;
    editor.setSelectionColor(key);
    refreshSwatchUI();
    dirty = true;
  });
  swatchesEl.appendChild(btn);
}

// Shape switcher: converts the selection in place (sticky ↔ shape kinds).
const shapesEl = $("popover-shapes");
const SHAPE_OPTIONS: [("sticky" | "rect" | "ellipse" | "diamond" | "pill"), IconNode, string][] = [
  ["sticky", StickyNote, "Sticky note"],
  ["rect", Square, "Rectangle"],
  ["ellipse", Circle, "Ellipse"],
  ["diamond", Diamond, "Diamond"],
  ["pill", RectangleHorizontal, "Pill"],
];
for (const [kind, icon, label] of SHAPE_OPTIONS) {
  const btn = document.createElement("button");
  btn.title = label;
  btn.dataset.kind = kind;
  btn.setAttribute("aria-label", label);
  btn.appendChild(createElement(icon, { width: 15, height: 15, "stroke-width": 1.75 }));
  btn.addEventListener("click", () => {
    editor.setSelectionShape(kind);
    refreshSwatchUI();
    dirty = true;
    dataPanel.scheduleRefresh();
  });
  shapesEl.appendChild(btn);
}

for (const fill of ["solid", "outline", "none"] as const) {
  const btn = document.createElement("button");
  btn.dataset.fill = fill;
  btn.textContent = fill[0]!.toUpperCase() + fill.slice(1);
  btn.addEventListener("click", () => {
    defaultFillStyle = fill;
    editor.setSelectionFillStyle(fill);
    refreshSwatchUI();
    dirty = true;
  });
  fillStylesEl.appendChild(btn);
}

swatchBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = !popover.classList.contains("open");
  popover.classList.toggle("open", willOpen);
  if (willOpen) {
    refreshSwatchUI();
    const r = swatchBtn.getBoundingClientRect();
    popover.style.left = `${r.right + 10}px`;
    popover.style.top = `${Math.min(r.top, window.innerHeight - 280)}px`;
  }
});
window.addEventListener("pointerdown", (e) => {
  if (!popover.contains(e.target as globalThis.Node) && e.target !== swatchBtn) {
    popover.classList.remove("open");
  }
});

refreshSwatchUI();

// --- export ------------------------------------------------------------------

const exportBtn = $("btn-export");
const exportMenu = $("export-menu");
exportBtn.prepend(createElement(Download, { width: 15, height: 15, "stroke-width": 2 }));

function exportBoard(): ExportBoard {
  return {
    title: BOARD.replace(/^orim-/, ""),
    nodes: [...store.nodes.values()],
    connectors: [...store.connectors.values()],
    comments: [...store.comments.values()],
  };
}

function download(filename: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG rasterization failed"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = Math.min(8192, Math.round(img.width * scale));
    c.height = Math.min(8192, Math.round(img.height * scale));
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const EXPORTERS: Record<string, () => Promise<void>> = {
  png: async () => download(`${BOARD}.png`, await svgToPngBlob(boardToSVG(exportBoard()))),
  svg: async () =>
    download(`${BOARD}.svg`, new Blob([boardToSVG(exportBoard())], { type: "image/svg+xml" })),
  md: async () =>
    download(`${BOARD}.md`, new Blob([boardToMarkdown(exportBoard())], { type: "text/markdown" })),
  mermaid: async () =>
    download(`${BOARD}.mmd`, new Blob([boardToMermaid(exportBoard())], { type: "text/plain" })),
  json: async () =>
    download(
      `${BOARD}.json`,
      new Blob([JSON.stringify(boardToJSON(exportBoard(), BOARD), null, 2)], { type: "application/json" }),
    ),
};

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle("open");
});
for (const btn of exportMenu.querySelectorAll<HTMLButtonElement>("[data-export]")) {
  btn.addEventListener("click", () => {
    exportMenu.classList.remove("open");
    void EXPORTERS[btn.dataset.export!]?.().catch((err) => console.error("export failed", err));
  });
}
window.addEventListener("pointerdown", (e) => {
  if (!exportMenu.contains(e.target as globalThis.Node) && !exportBtn.contains(e.target as globalThis.Node)) {
    exportMenu.classList.remove("open");
  }
});

// --- zoom & minimap ----------------------------------------------------------

function zoomToFit(): void {
  const bounds = editor.contentBounds();
  if (bounds) Object.assign(camera, cameraToFit(bounds, window.innerWidth, window.innerHeight));
  dirty = true;
}

$("zoom-in").addEventListener("click", () => {
  Object.assign(camera, zoomAt(camera, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 1.25));
  dirty = true;
});
$("zoom-out").addEventListener("click", () => {
  Object.assign(camera, zoomAt(camera, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 0.8));
  dirty = true;
});
$("zoom-fit").addEventListener("click", zoomToFit);

let minimapTransform: { scale: number; offsetX: number; offsetY: number } | null = null;
minimapCanvas.addEventListener("pointerdown", (e) => {
  if (!minimapTransform) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const wx = (mx - minimapTransform.offsetX) / minimapTransform.scale;
  const wy = (my - minimapTransform.offsetY) / minimapTransform.scale;
  camera.x = wx - window.innerWidth / 2 / camera.zoom;
  camera.y = wy - window.innerHeight / 2 / camera.zoom;
  dirty = true;
});

// --- render loop -------------------------------------------------------------

let frames = 0;
let fpsWindowStart = performance.now();
let lastMinimap = 0;

function frame(): void {
  const dataLinks = computeDataLinks();
  if (dirty || presences.length > 0 || overlay.activeId || dataLinks.length) {
    renderer.render({
      nodesSorted: store.nodesSorted,
      connectors: store.connectors,
      getNode: (id) => store.getNode(id),
      camera,
      selection: editor.selection,
      connectorSelection: editor.connectorSelection,
      editingId: overlay.activeId,
      presences,
      revision: store.revision,
      dataLinks,
      timestamp: performance.now(),
      portsFor:
        editor.tool === "select" || editor.tool === "connector"
          ? editor.hoveredId ?? editor.singleSelectedNode()?.id ?? null
          : null,
      comments: comments.visible(),
      activeCommentId: comments.activeId,
      marquee: editor.marquee,
      draftRect: editor.draftRect,
      draftConnector: editor.draftConnector,
      draftInk: editor.draftInk,
      draftColor: PALETTE[defaultColor].solid,
    });
    overlay.reposition(camera);
    comments.reposition();
    dirty = false;
  }

  const now = performance.now();
  if (now - lastMinimap > 250) {
    minimapTransform = renderer.renderMinimap(
      minimapCanvas,
      { nodesSorted: store.nodesSorted, camera },
      editor.contentBounds(),
    );
    lastMinimap = now;
  }

  frames++;
  if (now - fpsWindowStart >= 500) {
    $("stat-fps").textContent = String(Math.round((frames * 1000) / (now - fpsWindowStart)));
    $("stat-nodes").textContent = String(store.nodes.size + store.connectors.size);
    $("zoom-label").textContent = `${Math.round(camera.zoom * 100)}%`;
    frames = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(frame);
}

syncToolbar();
requestAnimationFrame(frame);

// Debug handle for verification (not part of the product surface).
declare global {
  interface Window {
    orim: {
      store: BoardStore;
      camera: Camera;
      editor: Editor;
      convert: { md(): string; mermaid(): string; svg(): string; json(): unknown };
    };
  }
}
window.orim = {
  store, camera, editor,
  convert: {
    md: () => boardToMarkdown(exportBoard()),
    mermaid: () => boardToMermaid(exportBoard()),
    svg: () => boardToSVG(exportBoard()),
    json: () => boardToJSON(exportBoard(), BOARD),
  },
};
