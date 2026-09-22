import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { BoardStore } from "@orim/store";
import { cellSource, type PaletteColor } from "@orim/schema";
import {
  Editor, cameraToFit, fieldChips, setChipMeasurer, setFieldCurrency,
  tableCellRect, toScreen, toWorld, zoomAt, type Camera, type ToolName,
} from "@orim/editor";
import {
  Renderer, CHIP_FONT, PALETTE, PALETTE_KEYS, CURSOR_COLORS,
  type PresenceState,
} from "@orim/renderer";
import {
  boardToJSON, boardToMarkdown, boardToMermaid, boardToSVG, orderBoard, TEMPLATES,
  type ExportBoard,
} from "@orim/convert";
import { TextEditorOverlay, isEditable } from "./editor-overlay";
import { confirmDialog, promptDialog } from "./dialogs";
import { feedOf, refreshTableFeed } from "./table-feed";
import { EmbedLayer } from "./embed-layer";
import { DataPanel } from "./data-panel";
import { A11yMirror } from "./a11y-mirror";
import { ORIM_CLIP_MARKER, setupFileDrop, setupPaste } from "./import-drop";
import { CommentsUI } from "./comments-ui";
import { api, authName, authToken, openAuthDialog, WS_URL } from "./auth";
import { findEmptySpace, tree } from "@orim/layout";
import {
  createElement, MousePointer2, Hand, StickyNote, Square, Circle, Diamond,
  Type, Frame, MoveUpRight, Pencil, Download, Table, RectangleHorizontal,
  MessageCircle, Share2, Presentation, Timer as TimerIcon, EyeOff, Vote,
  History as HistoryIcon, Database, type IconNode,
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

// Chip layout uses real text measurement so hit rects match drawn pixels.
{
  const mctx = document.createElement("canvas").getContext("2d")!;
  setChipMeasurer((text, bold) => {
    mctx.font = `${bold ? "600 " : ""}${CHIP_FONT}px -apple-system, system-ui, sans-serif`;
    return mctx.measureText(text).width;
  });
}

/** Currency for cost-shaped fields: a synced board setting, defaulting
 *  from the browser locale. */
function localeCurrency(): string {
  const lang = navigator.language ?? "";
  if (/-(GB|UK)/i.test(lang)) return "£";
  if (/^(de|fr|es|it|nl|pt|fi|et|el|sk|sl|lv|lt|ie)/i.test(lang)) return "€";
  return "$";
}
function applyCurrency(): void {
  setFieldCurrency(store.getMeta<string>("currency") ?? localeCurrency());
}
applyCurrency();
const overlay = new TextEditorOverlay(document.getElementById("overlay-root")!);
const embeds = new EmbedLayer(document.getElementById("overlay-root")!);
renderer.onNeedsRender = () => {
  dirty = true;
};
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
  openFieldEditor: (node, key) => openFieldChipEditor(node, key),
  addTreeChild: (parentId) => addTreeChild(parentId),
  bindNodeToCell: (req) => bindNodeToCell(req),
  openTextEditor: (node) => openNodeTextEditor(node),
});

/**
 * Bind a text-bearing node to one table cell: the cell becomes the
 * source of truth for the node's text. An empty cell first adopts the
 * node's current text, so linking never loses work.
 */
function bindNodeToCell(req: {
  nodeId: string; tableId: string; rowId: string; columnId: string;
}): boolean {
  if (readOnly) return false;
  const node = store.getNode(req.nodeId);
  const table = store.getNode(req.tableId);
  if (!node || !("text" in node) || table?.type !== "table") return false;
  const row = table.rows.find((r) => r.id === req.rowId);
  const col = table.columns.find((c) => c.id === req.columnId);
  if (!row || !col) return false;

  const cellText = row.cells[col.id] ?? "";
  store.transact(() => {
    if (!cellText && node.text) {
      store.updateNode(table.id, {
        rows: table.rows.map((r) =>
          r.id === row.id ? { ...r, cells: { ...r.cells, [col.id]: node.text } } : r,
        ),
      });
    }
    store.updateNode(node.id, {
      data: { ...node.data, $source: { table: table.id, row: row.id, column: col.id } },
    });
  });
  reconcileDerived();
  toast(`Linked to “${col.name}” — the cell is now the source of truth`);
  dirty = true;
  dataPanel.scheduleRefresh();
  return true;
}

function openNodeTextEditor(node: import("@orim/schema").Node): void {
  if (node.type === "frame") {
    openFrameTitleEditor(node);
  } else if (isEditable(node)) {
    overlay.open(node, camera, (text) => commitNodeText(node, text));
  }
  dirty = true;
}

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
  canEdit: () => !readOnly && !historyStore,
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
    if (readOnly || overlay.activeId) return true;
    const t = document.activeElement;
    return (
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    );
  },
  loadClipboard: (json) => editor.loadClipboard(json),
  internalPaste: () => {
    editor.paste();
    dirty = true;
    dataPanel.scheduleRefresh();
  },
});

/** Inline editor for a smart-field chip (double-clicked on canvas). */
function openFieldChipEditor(node: import("@orim/schema").Node, key: string): void {
  const chip = fieldChips(node).find((c) => c.key === key);
  if (!chip) return;
  const s = toScreen(camera, chip.rect);
  const input = document.createElement("input");
  input.value = String((node.data as Record<string, unknown>)[key] ?? "");
  input.style.cssText = `position:absolute; left:${s.x}px; top:${s.y - 4}px;
    width:${Math.max(64, chip.rect.w * camera.zoom + 24)}px;
    pointer-events:auto; font:600 12px -apple-system,system-ui,sans-serif;
    color:#1f2430; padding:3px 8px; border:none; outline:2px solid var(--accent);
    border-radius:9px; background:#fff;`;
  document.getElementById("overlay-root")!.appendChild(input);
  input.focus();
  input.select();
  let cancelled = false;
  const commit = () => {
    if (!cancelled) {
      const live = store.getNode(node.id);
      if (live) {
        const raw = input.value.trim();
        const num = Number(raw);
        const data = { ...live.data } as Record<string, unknown>;
        if (raw === "") delete data[key];
        else data[key] = Number.isFinite(num) && raw !== "" ? num : raw;
        store.updateNode(node.id, { data });
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
  });
}

// --- sync --------------------------------------------------------------------

const provider = new HocuspocusProvider({
  url: WS_URL,
  name: BOARD,
  document: doc,
  token: authToken(),
  onAuthenticationFailed: () => {
    toast("This board is private — sign in with an account that has access.", true);
    $("stat-conn").textContent = "no access";
    $("status-dot").classList.remove("connected");
    if (!readOnly) enterReadOnly("Private board — your cached copy, view only");
  },
  onStatus: ({ status }) => {
    $("stat-conn").textContent = status === "connected" ? "synced" : status;
    $("status-dot").classList.toggle("connected", status === "connected");
  },
  onSynced: () => {
    maybeSeedTemplate();
    refreshStaleFeeds();
  },
});

// Remember this board locally, so the start page works offline.
try {
  const bare = BOARD.replace(/^orim-/, "");
  const list = (JSON.parse(localStorage.getItem("orim-recents") ?? "[]") as { name: string; at: number }[])
    .filter((r) => r.name !== bare);
  list.unshift({ name: bare, at: Date.now() });
  localStorage.setItem("orim-recents", JSON.stringify(list.slice(0, 24)));
} catch { /* private mode etc. */ }

/** A fresh board opened with ?template= seeds itself once, then drops the param. */
let seeded = false;
function maybeSeedTemplate(): void {
  if (seeded) return;
  seeded = true;
  const wanted = new URLSearchParams(location.search).get("template");
  const template = wanted && TEMPLATES.find((t) => t.id === wanted);
  if (!template || store.nodes.size > 0) return;
  const built = template.build(newId);
  store.transact(() => {
    for (const n of built.nodes) store.upsertNode({ ...n, index: store.topIndex() });
    for (const c of built.connectors) store.upsertConnector(c);
  });
  zoomToFit();
  const params = new URLSearchParams(location.search);
  params.delete("template");
  history.replaceState(null, "", `/?${params}`);
  toast(`Started from the ${template.name} template`);
}

const me = {
  name: authName() ?? `Guest-${Math.floor(Math.random() * 900 + 100)}`,
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
  updateVoteBar();
  updateTimerBar();
  checkRevealAsk();
  applyCurrency();
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
  if (embeds.active) {
    embeds.activate(null); // clicking the board hands the pointer back
    dirty = true;
  }
  if (editor.tool === "select" || editor.tool === "hand") {
    const pin = comments.pinAt({ x: e.clientX, y: e.clientY });
    if (pin) {
      comments.open(pin.id);
      dirty = true;
      return;
    }
  }
  // During a voting session, clicking votable content votes.
  if (votingActive() && !readOnly && editor.tool === "select") {
    const hit = editor.hitNode(toWorld(camera, { x: e.clientX, y: e.clientY }));
    if (hit && VOTABLE.has(hit.type)) {
      castVote(hit.id, e.shiftKey ? -1 : 1);
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
  if (historyStore) return; // time-travel view is look, don't touch
  // Double-clicking an embed hands it the pointer (scroll, click links);
  // Escape or clicking the canvas gives it back. Works for viewers too.
  const hit = editor.hitNode(info(e).world);
  if (hit?.type === "embed") {
    embeds.activate(hit.id);
    dirty = true;
    return;
  }
  if (readOnly) return;
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

// --- tree authoring (Tab = child, Enter = sibling, "+" under selection) ------

type TreeEdge = import("@orim/schema").Connector & {
  from: { node: string; anchor: string };
  to: { node: string; anchor: string };
};

/** Strict parent→child edges (bottom → top), the marker of tree diagrams. */
function treeEdges(): TreeEdge[] {
  return [...store.connectors.values()].filter(
    (c): c is TreeEdge =>
      "node" in c.from && c.from.anchor === "s" &&
      "node" in c.to && c.to.anchor === "n",
  );
}

const treeParentEdgeOf = (id: string): TreeEdge | null =>
  treeEdges().find((c) => c.to.node === id) ?? null;

/** A node's tree children in visual (left-to-right) order. */
function treeChildrenOf(id: string): import("@orim/schema").Node[] {
  return treeEdges()
    .filter((c) => c.from.node === id)
    .map((c) => store.getNode(c.to.node))
    .filter((n): n is import("@orim/schema").Node => !!n)
    .sort((a, b) => a.x - b.x);
}

/**
 * Arrow-key navigation over a tree: Up = parent, Down = the child
 * nearest below, Left/Right = previous/next sibling. Returns whether
 * the key was handled (a single tree node was selected).
 */
function navigateTree(key: string): boolean {
  const n = editor.singleSelectedNode();
  if (!n || !editor.isTreeMember(n.id)) return false;
  const parentEdge = treeParentEdgeOf(n.id);
  let target: import("@orim/schema").Node | null | undefined = null;

  if (key === "ArrowUp") {
    target = parentEdge && store.getNode(parentEdge.from.node);
  } else if (key === "ArrowDown") {
    const kids = treeChildrenOf(n.id);
    const cx = n.x + n.w / 2;
    target = kids.reduce<import("@orim/schema").Node | null>(
      (best, k) =>
        !best || Math.abs(k.x + k.w / 2 - cx) < Math.abs(best.x + best.w / 2 - cx) ? k : best,
      null,
    );
  } else if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!parentEdge) return true; // a root has no siblings; swallow the key
    const siblings = treeChildrenOf(parentEdge.from.node);
    const i = siblings.findIndex((s) => s.id === n.id);
    target = key === "ArrowLeft" ? siblings[i - 1] : siblings[i + 1];
  }

  if (target) {
    editor.clearSelection();
    editor.selection.add(target.id);
    ensureOnScreen(target);
    dataPanel.scheduleRefresh();
  }
  return true;
}

/**
 * Add a connected child under `parentId` and rebalance that whole tree
 * with the tidy layout. New siblings inherit the last child's look, a
 * first child inherits its parent's; the child opens ready to type.
 */
function addTreeChild(parentId: string): void {
  if (readOnly) return;
  const parent = store.getNode(parentId);
  if (!parent || parent.type === "frame" || parent.type === "ink" || parent.type === "table") {
    return;
  }
  const edges = treeEdges();
  const siblings = edges
    .filter((c) => c.from.node === parentId)
    .map((c) => store.getNode(c.to.node))
    .filter((n): n is import("@orim/schema").Node => !!n);
  const template = siblings[siblings.length - 1] ?? parent;

  const id = newId();
  const base = {
    id, parent: null, rotation: 0, index: store.topIndex(), locked: false,
    data: {} as Record<string, unknown>,
    x: parent.x, y: parent.y + parent.h + 88,
    w: template.w, h: template.h,
  };
  const color = "color" in template && template.color ? template.color : defaultColor;
  let child: import("@orim/schema").Node;
  if (template.type === "sticky") {
    child = { ...base, type: "sticky", text: "", color, author: undefined };
  } else if (template.type === "text") {
    child = { ...base, type: "text", text: "", fontSize: template.fontSize };
  } else {
    child = {
      ...base, type: "shape",
      kind: template.type === "shape" ? template.kind : "rect",
      text: "", color,
      fillStyle: template.type === "shape" ? template.fillStyle : defaultFillStyle,
    };
  }
  const edge: TreeEdge = {
    id: newId(), type: "connector",
    from: { node: parentId, anchor: "s" },
    to: { node: id, anchor: "n" },
    label: "", style: "arrow", index: store.topIndex(), data: {},
  } as TreeEdge;

  // Rebalance the connected tree component (old edges + the new one).
  const allEdges = [...edges, edge];
  const adjacent = new Map<string, string[]>();
  for (const c of allEdges) {
    if (!adjacent.has(c.from.node)) adjacent.set(c.from.node, []);
    if (!adjacent.has(c.to.node)) adjacent.set(c.to.node, []);
    adjacent.get(c.from.node)!.push(c.to.node);
    adjacent.get(c.to.node)!.push(c.from.node);
  }
  const member = new Set<string>([parentId]);
  const stack = [parentId];
  while (stack.length) {
    for (const nb of adjacent.get(stack.pop()!) ?? []) {
      if (!member.has(nb)) {
        member.add(nb);
        stack.push(nb);
      }
    }
  }
  const memberNodes = [...member]
    .map((m) => (m === id ? child : store.getNode(m)))
    .filter((n): n is import("@orim/schema").Node => !!n);
  const positions = tree(memberNodes, allEdges);

  store.transact(() => {
    store.upsertNode(child);
    store.upsertConnector(edge);
    for (const n of memberNodes) {
      const p = positions.get(n.id);
      if (p && (n.x !== p.x || n.y !== p.y)) store.upsertNode({ ...n, x: p.x, y: p.y });
    }
  });

  editor.clearSelection();
  editor.selection.add(id);
  const placed = store.getNode(id);
  if (placed) {
    ensureOnScreen(placed);
    openNodeTextEditor(placed);
  }
  dirty = true;
  dataPanel.scheduleRefresh();
}

/** Move the selection by a keyboard nudge; frames carry their children. */
function nudgeSelection(dx: number, dy: number): void {
  if (readOnly || !editor.selection.size) return;
  const ids = new Set<string>();
  const add = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    const n = store.getNode(id);
    if (n?.type === "frame") {
      for (const child of store.nodes.values()) {
        if (child.parent === id) add(child.id);
      }
    }
  };
  for (const id of editor.selection) add(id);
  store.transact(() => {
    for (const id of ids) {
      const n = store.getNode(id);
      if (n && !n.locked) store.updateNode(id, { x: n.x + dx, y: n.y + dy });
    }
  });
  dirty = true;
  dataPanel.scheduleRefresh();
}

/** Nudge the camera the minimal amount to keep a node in view. */
function ensureOnScreen(n: { x: number; y: number; w: number; h: number }): void {
  const M = 72;
  const sx = (n.x - camera.x) * camera.zoom;
  const sy = (n.y - camera.y) * camera.zoom;
  const sw = n.w * camera.zoom;
  const sh = n.h * camera.zoom;
  if (sx < M) camera.x -= (M - sx) / camera.zoom;
  if (sy < M) camera.y -= (M - sy) / camera.zoom;
  if (sx + sw > window.innerWidth - M) {
    camera.x += (sx + sw - (window.innerWidth - M)) / camera.zoom;
  }
  if (sy + sh > window.innerHeight - M) {
    camera.y += (sy + sh - (window.innerHeight - M)) / camera.zoom;
  }
}

// --- linked tables: refresh stale sources on open ----------------------------

const FEED_STALE_MS = 5 * 60_000;
function refreshStaleFeeds(): void {
  if (readOnly) return;
  for (const n of store.nodes.values()) {
    if (n.type !== "table") continue;
    const feed = feedOf(n);
    if (!feed || Date.now() - (feed.refreshedAt ?? 0) < FEED_STALE_MS) continue;
    refreshTableFeed(store, n.id)
      .then(() => {
        reconcileDerived();
        dirty = true;
        dataPanel.scheduleRefresh();
      })
      .catch(() => { /* source offline or fetching disabled — keep last data */ });
  }
}

// --- board menu (burger dropdown for the secondary actions) ------------------

const menuToggle = $("menu-toggle");
const menuDropdown = $("menu-dropdown");
const MENU_ICONS: [string, IconNode][] = [
  ["btn-share", Share2],
  ["btn-present", Presentation],
  ["btn-timer", TimerIcon],
  ["btn-drafts", EyeOff],
  ["btn-vote", Vote],
  ["btn-history", HistoryIcon],
  ["btn-data", Database],
];
for (const [id, icon] of MENU_ICONS) {
  $(id).prepend(createElement(icon, { width: 17, height: 17, "stroke-width": 1.75 }));
}
function setMenuOpen(open: boolean): void {
  menuDropdown.hidden = !open;
  menuToggle.setAttribute("aria-expanded", String(open));
}
menuToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(menuDropdown.hidden);
});
menuDropdown.addEventListener("click", () => setMenuOpen(false));
window.addEventListener("pointerdown", (e) => {
  if (!menuDropdown.hidden && !(e.target as HTMLElement).closest?.("#exportbar")) {
    setMenuOpen(false);
  }
});

// --- board history (server-side snapshots; restore = ordinary edits) ---------

interface HistoryRow { id: number; at: number; label: string | null; size: number }

let historyStore: BoardStore | null = null;
let historyAt: number | null = null;
let historyViewingId: number | null = null;
let toolBeforeHistory: ToolName = "select";

const historyPanel = $("historypanel");
const fmtWhen = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

async function refreshHistoryList(): Promise<void> {
  const list = $("history-list");
  try {
    const rows = await api<HistoryRow[]>(
      "GET", `/boards/history?board=${encodeURIComponent(bareBoard)}`,
    );
    list.replaceChildren();
    if (!rows.length) {
      list.innerHTML = `<div class="hint">No versions yet — snapshots are saved automatically as the board changes.</div>`;
      return;
    }
    for (const row of rows) {
      const btn = document.createElement("button");
      btn.className = "history-row";
      if (row.id === historyViewingId) btn.classList.add("viewing");
      const title = document.createElement("b");
      title.textContent = row.label ?? "Auto snapshot";
      const sub = document.createElement("span");
      sub.textContent = fmtWhen(row.at);
      btn.append(title, sub);
      btn.addEventListener("click", () => void viewVersion(row));
      list.appendChild(btn);
    }
  } catch (err) {
    list.innerHTML = `<div class="hint"></div>`;
    list.querySelector(".hint")!.textContent =
      `History unavailable: ${err instanceof Error ? err.message : err}`;
  }
}

async function viewVersion(row: HistoryRow): Promise<void> {
  const { state } = await api<{ state: string }>(
    "GET", `/boards/history/state?id=${row.id}`,
  );
  const doc = new Y.Doc();
  if (!historyStore) toolBeforeHistory = editor.tool;
  // Store first, then update: caches fill from the observer events.
  historyStore = new BoardStore(doc);
  Y.applyUpdate(doc, Uint8Array.from(atob(state), (c) => c.charCodeAt(0)));
  historyAt = row.at;
  historyViewingId = row.id;
  editor.clearSelection();
  editor.tool = "hand";
  embeds.activate(null);
  overlay.close();
  document.body.classList.add("history-viewing");
  $("history-banner").hidden = false;
  $("history-when").textContent = fmtWhen(row.at);
  ($("history-restore") as HTMLButtonElement).disabled = readOnly;
  a11y.announce(`Viewing board version from ${fmtWhen(row.at)} — read only`);
  void refreshHistoryList();
  dirty = true;
}

function exitHistory(): void {
  if (!historyStore) return;
  historyStore = null;
  historyAt = null;
  historyViewingId = null;
  document.body.classList.remove("history-viewing");
  $("history-banner").hidden = true;
  editor.tool = toolBeforeHistory;
  void refreshHistoryList();
  dirty = true;
}

async function restoreVersion(): Promise<void> {
  if (!historyStore || readOnly) return;
  const old = historyStore;
  const when = historyAt ? fmtWhen(historyAt) : "this version";
  if (!(await confirmDialog(
    `Restore the board to ${when}? Current content is replaced — you can undo.`,
    "Restore",
  ))) return;
  store.transact(() => {
    for (const n of old.nodes.values()) store.upsertNode(n);
    for (const c of old.connectors.values()) store.upsertConnector(c);
    for (const cm of old.comments.values()) store.upsertComment(cm);
    for (const id of [...store.nodes.keys()]) {
      if (!old.nodes.has(id)) store.deleteNode(id);
    }
    for (const id of [...store.connectors.keys()]) {
      if (!old.connectors.has(id)) store.deleteConnector(id);
    }
    for (const id of [...store.comments.keys()]) {
      if (!old.comments.has(id)) store.deleteComment(id);
    }
  });
  void api("POST", "/boards/restored", { board: bareBoard, at: historyAt })
    .catch(() => { /* audit is best effort for offline boards */ });
  exitHistory();
  toast(`Restored the version from ${when} — ⌘Z undoes it`);
  a11y.scheduleRebuild();
}

$("btn-history").addEventListener("click", () => {
  const open = historyPanel.classList.toggle("open");
  if (open) void refreshHistoryList();
  else exitHistory();
});
$("history-back").addEventListener("click", exitHistory);
$("history-restore").addEventListener("click", () => void restoreVersion());
$("history-save").addEventListener("click", () => {
  void promptDialog({
    title: "Save a labelled version",
    placeholder: "Label (e.g. pre-workshop baseline)",
    confirm: "Save",
  }).then(async (label) => {
    if (label === null) return;
    try {
      await api("POST", "/boards/snapshot", { board: bareBoard, label });
      toast("Version saved");
      void refreshHistoryList();
    } catch (err) {
      toast(`Couldn't save: ${err instanceof Error ? err.message : err}`, true);
    }
  });
});

// --- present mode (each frame is a slide, in reading order) ------------------

let presenting = false;
let presentIndex = 0;
let cameraAnim: number | null = null;

/** Frames in the same reading order exports and the a11y mirror use. */
function presentFrames(): import("@orim/schema").FrameNode[] {
  return orderBoard({
    nodes: [...store.nodes.values()],
    connectors: [...store.connectors.values()],
  }).frames.map((f) => f.frame);
}

/** Glide the camera to a target (zoom eased exponentially). */
function animateCamera(target: Camera, duration = 480): void {
  if (cameraAnim !== null) cancelAnimationFrame(cameraAnim);
  const from = { x: camera.x, y: camera.y, zoom: camera.zoom };
  const t0 = performance.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    const k = ease(t);
    camera.zoom = from.zoom * (target.zoom / from.zoom) ** k;
    camera.x = from.x + (target.x - from.x) * k;
    camera.y = from.y + (target.y - from.y) * k;
    dirty = true;
    cameraAnim = t < 1 ? requestAnimationFrame(step) : null;
  };
  cameraAnim = requestAnimationFrame(step);
}

function presentGo(index: number): void {
  const frames = presentFrames();
  if (!frames.length) {
    stopPresenting();
    return;
  }
  presentIndex = Math.max(0, Math.min(frames.length - 1, index));
  const f = frames[presentIndex]!;
  // Include the title strip above the frame in the shot.
  animateCamera(
    cameraToFit(
      { x: f.x, y: f.y - 32, w: f.w, h: f.h + 32 },
      window.innerWidth, window.innerHeight, 72,
    ),
  );
  $("present-label").textContent = `${presentIndex + 1} / ${frames.length} · ${f.title}`;
  a11y.announce(`Slide ${presentIndex + 1} of ${frames.length}: ${f.title}`);
}

function startPresenting(): void {
  if (presenting) return;
  if (!presentFrames().length) {
    toast("Add frames to present — each frame is a slide.", true);
    return;
  }
  presenting = true;
  document.body.classList.add("presenting");
  ($("present-hud") as HTMLElement).hidden = false;
  editor.clearSelection();
  editor.tool = "select";
  embeds.activate(null);
  presentGo(0);
}

function stopPresenting(): void {
  if (!presenting) return;
  presenting = false;
  document.body.classList.remove("presenting");
  ($("present-hud") as HTMLElement).hidden = true;
  dirty = true;
}

$("btn-present").addEventListener("click", startPresenting);
$("present-prev").addEventListener("click", () => presentGo(presentIndex - 1));
$("present-next").addEventListener("click", () => presentGo(presentIndex + 1));
$("present-exit").addEventListener("click", stopPresenting);

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
  if (t.closest?.("#a11y-mirror")) return; // the mirror owns its own arrows
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // History view is read-only: pan/zoom only, Escape returns to now.
  if (historyStore) {
    if (e.key === "Escape") exitHistory();
    else if (key === "1") zoomToFit();
    else if (key === "0") camera.zoom = 1;
    dirty = true;
    return;
  }

  // Present mode owns navigation keys (viewers can present too).
  if (presenting) {
    if (["ArrowRight", " ", "PageDown"].includes(e.key)) {
      e.preventDefault();
      presentGo(presentIndex + 1);
    } else if (["ArrowLeft", "PageUp"].includes(e.key)) {
      e.preventDefault();
      presentGo(presentIndex - 1);
    } else if (e.key === "Escape") {
      stopPresenting();
    }
    return;
  }

  if (readOnly && !["1", "0", "\\"].includes(key)) return;

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
      const payload = editor.serializeClipboard();
      void navigator.clipboard
        ?.writeText(ORIM_CLIP_MARKER + (payload ?? ""))
        .catch(() => {});
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
  } else if (e.key === "Tab") {
    // Tab adds a connected child to the selected node (starts a tree).
    const n = editor.singleSelectedNode();
    if (n && n.type !== "frame" && n.type !== "ink" && n.type !== "table") {
      e.preventDefault();
      addTreeChild(n.id);
    }
  } else if (e.key === "Enter") {
    // Enter adds a sibling when the selected node has a tree parent.
    const n = editor.singleSelectedNode();
    const parentEdge = n && treeParentEdgeOf(n.id);
    if (parentEdge) {
      e.preventDefault();
      addTreeChild(parentEdge.from.node);
    }
  } else if (e.key.startsWith("Arrow")) {
    // Plain arrows navigate a tree when a single tree node is selected;
    // otherwise they nudge the selection (Shift = big step). Alt always
    // nudges, so tree nodes can be moved from the keyboard too.
    const treeNav = !e.altKey && !e.shiftKey && navigateTree(e.key);
    if (treeNav) {
      e.preventDefault();
    } else if (editor.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 32 : 8;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const delta = deltas[e.key];
      if (delta) nudgeSelection(delta[0], delta[1]);
    }
  } else if (e.key === "Escape") {
    embeds.activate(null);
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

// Custom tooltips: every titled button gets a styled tip (placement by
// container) plus an aria-label; the native title tooltip is removed.
function setupTooltips(): void {
  for (const btn of document.querySelectorAll<HTMLElement>("button[title]")) {
    if (!btn.getAttribute("aria-label")) btn.setAttribute("aria-label", btn.title);
    btn.dataset.tip = btn.title;
    if (btn.closest("#toolbar")) btn.dataset.tipAt = "right";
    else if (btn.closest("#zoombar") || btn.closest("#color-popover")) btn.dataset.tipAt = "top";
    btn.removeAttribute("title");
  }
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

// Conditional colors: rules live in synced board meta and tint notes at
// render time by their data — the color home is the color popover.
let renderRules: () => void = () => {};
{
  const rulesList = $("popover-rules");
  const OPS: import("@orim/editor").ColorRule["op"][] = [">", ">=", "<", "<=", "=", "!=", "contains"];
  const RULE_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink", "gray"] as const;
  type Rule = import("@orim/editor").ColorRule;
  const readRules = (): Rule[] => (store.getMeta<Rule[]>("colorRules") ?? []).slice();
  const writeRules = (rules: Rule[]): void => {
    store.setMeta("colorRules", rules);
    dirty = true;
  };
  renderRules = () => {
    rulesList.replaceChildren();
    readRules().forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "rule-row";
      const patch = (p: Partial<Rule>) => {
        const rules = readRules();
        rules[i] = { ...rules[i]!, ...p };
        writeRules(rules);
      };
      const field = document.createElement("input");
      field.placeholder = "field";
      field.value = rule.field;
      field.addEventListener("change", () => patch({ field: field.value.trim() }));
      const op = document.createElement("select");
      for (const o of OPS) op.add(new Option(o, o));
      op.value = rule.op;
      op.addEventListener("change", () => patch({ op: op.value as Rule["op"] }));
      const value = document.createElement("input");
      value.placeholder = "value";
      value.value = rule.value;
      value.addEventListener("change", () => patch({ value: value.value }));
      const color = document.createElement("select");
      color.className = "rule-color";
      color.setAttribute("aria-label", "Rule color");
      for (const c of RULE_COLORS) color.add(new Option(c, c));
      color.value = rule.color;
      color.style.background = PALETTE[rule.color].fill;
      color.addEventListener("change", () => {
        color.style.background = PALETTE[color.value as Rule["color"]].fill;
        patch({ color: color.value as Rule["color"] });
      });
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove rule";
      remove.addEventListener("click", () => {
        const rules = readRules();
        rules.splice(i, 1);
        writeRules(rules);
        renderRules();
      });
      row.append(field, op, value, color, remove);
      rulesList.appendChild(row);
    });
  };
  $("rule-add").addEventListener("click", () => {
    writeRules([...readRules(), { field: "", op: ">", value: "", color: "red" }]);
    renderRules();
    rulesList.querySelector("input")?.focus();
  });
}

swatchBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = !popover.classList.contains("open");
  popover.classList.toggle("open", willOpen);
  if (willOpen) {
    refreshSwatchUI();
    renderRules();
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

// --- access & sharing --------------------------------------------------------

const bareBoard = BOARD.replace(/^orim-/, "");

// Board identity next to the logo; the project folder comes from the server.
$("board-name").textContent = bareBoard;
document.title = `${bareBoard} — Orim`;
void api<{ name: string; project: string | null }[]>("GET", "/boards")
  .then((rows) => {
    const mine = rows.find((r) => r.name === bareBoard);
    if (mine?.project) $("board-project").textContent = mine.project;
  })
  .catch(() => { /* offline: name alone is fine */ });
let readOnly = false;
interface AccessInfo { role: string; mode: string; ownerName: string | null }
let access: AccessInfo = { role: "editor", mode: "link-edit", ownerName: null };

async function refreshAccess(): Promise<void> {
  try {
    access = await api<AccessInfo>(
      "GET",
      `/boards/access?board=${encodeURIComponent(bareBoard)}`,
    );
    if (access.role === "viewer" && !readOnly) enterReadOnly();
    if (access.role === "none" && !readOnly) {
      enterReadOnly("Private board — your cached copy, view only");
    }
  } catch { /* server offline → local-first editing */ }
}

function enterReadOnly(label = "View only"): void {
  readOnly = true;
  comments.readOnly = true;
  $("toolbar").style.display = "none";
  editor.tool = "hand";
  editor.clearSelection();
  const chip = document.createElement("div");
  chip.className = "panel";
  chip.textContent = label;
  chip.style.cssText =
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);padding:6px 14px;font-size:12px;color:#6b7280;z-index:10;";
  document.body.appendChild(chip);
  dirty = true;
}
void refreshAccess();

$("btn-share").addEventListener("click", () => void openShareDialog());

async function openShareDialog(): Promise<void> {
  await refreshAccess();
  document.getElementById("share-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.id = "share-backdrop";
  const canManage = access.role === "owner" || access.ownerName === null;
  const link = `${location.origin}/?b=${encodeURIComponent(bareBoard)}`;
  backdrop.innerHTML = `
    <div class="dialog panel" role="dialog" aria-label="Share board">
      <h3>Share "${bareBoard}"</h3>
      <div class="row">
        <input id="share-link" readonly value="${link}" />
        <button id="share-copy">Copy</button>
      </div>
      <h4>Access</h4>
      <div id="share-modes"></div>
      <div class="err" id="share-owner-note"></div>
      <div id="share-people"></div>
      <div class="err" id="share-err"></div>
    </div>`;
  document.body.appendChild(backdrop);
  const q = (id: string) => backdrop.querySelector<HTMLElement>(`#${id}`)!;

  q("share-copy").addEventListener("click", () => {
    void navigator.clipboard?.writeText(link);
    q("share-copy").textContent = "Copied";
  });

  const ownerNote = q("share-owner-note");
  ownerNote.style.color = "#9ca3af";
  const renderOwnerNote = () => {
    ownerNote.textContent = access.ownerName
      ? `Owned by ${access.ownerName}`
      : authName()
        ? "Unowned — changing access makes you the owner."
        : "Sign in below to own and restrict this board.";
  };
  renderOwnerNote();

  const MODES: [string, string, string][] = [
    ["link-edit", "Anyone with the link can edit", "The default for quick collaboration"],
    ["link-view", "Anyone with the link can view", "Others watch; people you add can edit"],
    ["private", "Private", "Only people you add below"],
  ];
  const modesEl = q("share-modes");
  for (const [value, label, sub] of MODES) {
    const row = document.createElement("label");
    row.className = "radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "share-mode";
    radio.value = value;
    radio.checked = access.mode === value;
    radio.disabled = !canManage;
    const text = document.createElement("span");
    text.textContent = label;
    const subEl = document.createElement("span");
    subEl.className = "sub";
    subEl.textContent = sub;
    text.appendChild(subEl);
    row.append(radio, text);
    radio.addEventListener("change", () => {
      void (async () => {
        try {
          access = await api<AccessInfo>("POST", "/boards/share", { board: bareBoard, mode: value });
          q("share-err").textContent = "";
          renderOwnerNote();
        } catch (err) {
          q("share-err").textContent = err instanceof Error ? err.message : String(err);
          await openShareDialog();
        }
      })();
    });
    modesEl.appendChild(row);
  }

  const people = q("share-people");
  if (!authName()) {
    const btn = document.createElement("button");
    btn.textContent = "Sign in";
    btn.addEventListener("click", () => {
      void openAuthDialog().then((name) => {
        if (name) location.reload();
      });
    });
    people.appendChild(btn);
  } else if (canManage) {
    const h = document.createElement("h4");
    h.textContent = "People";
    people.appendChild(h);
    try {
      const grants = await api<{ name: string; role: string }[]>(
        "GET",
        `/boards/shares?board=${encodeURIComponent(bareBoard)}`,
      );
      for (const g of grants) {
        const row = document.createElement("div");
        row.className = "share-row";
        const nameEl = document.createElement("span");
        nameEl.textContent = g.name;
        const sel = document.createElement("select");
        for (const r of ["editor", "viewer", "none"]) {
          const opt = document.createElement("option");
          opt.value = r;
          opt.textContent = r === "none" ? "remove" : `can ${r === "editor" ? "edit" : "view"}`;
          opt.selected = g.role === r;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => {
          void api("POST", "/boards/grant", { board: bareBoard, name: g.name, role: sel.value })
            .then(() => openShareDialog())
            .catch((err) => (q("share-err").textContent = String(err.message ?? err)));
        });
        row.append(nameEl, sel);
        people.appendChild(row);
      }
    } catch { /* shares unavailable */ }
    const addRow = document.createElement("div");
    addRow.className = "row";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "Add person by name";
    const roleSel = document.createElement("select");
    for (const r of ["editor", "viewer"]) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = `can ${r === "editor" ? "edit" : "view"}`;
      roleSel.appendChild(opt);
    }
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", () => {
      if (!nameInput.value.trim()) return;
      void api("POST", "/boards/grant", {
        board: bareBoard, name: nameInput.value.trim(), role: roleSel.value,
      })
        .then(() => openShareDialog())
        .catch((err) => (q("share-err").textContent = String(err.message ?? err)));
    });
    addRow.append(nameInput, roleSel, addBtn);
    people.appendChild(addRow);
  }

  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  for (const input of backdrop.querySelectorAll("input")) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") backdrop.remove();
    });
  }
}

// --- voting ------------------------------------------------------------------

interface VotingSession { active: boolean; budget: number; startedBy: string }
const votingSession = (): VotingSession | undefined => store.getMeta<VotingSession>("voting");
const votingActive = (): boolean => votingSession()?.active === true;
const VOTABLE = new Set(["sticky", "shape", "text"]);

function castVote(nodeId: string, delta: 1 | -1): void {
  const session = votingSession();
  if (!session?.active) return;
  const mine = store.voteOf(nodeId, me.name);
  if (delta > 0 && store.votesSpent(me.name) >= session.budget) {
    toast(`All ${session.budget} votes spent — shift-click to take one back.`, true);
    return;
  }
  if (delta < 0 && mine === 0) return;
  store.setVote(nodeId, me.name, mine + delta);
}

function updateVoteBar(): void {
  const session = votingSession();
  const bar = $("votebar");
  const active = session?.active === true && !readOnly;
  bar.classList.toggle("active", active);
  $("btn-vote").classList.toggle("active", session?.active === true);
  if (!active || !session) return;
  const spent = store.votesSpent(me.name);
  const left = Math.max(0, session.budget - spent);
  $("vote-remaining").textContent = `${left} left`;
  const dots = $("vote-dots");
  if (dots.childElementCount !== session.budget) {
    dots.replaceChildren(
      ...Array.from({ length: session.budget }, () => document.createElement("span")),
    );
  }
  [...dots.children].forEach((dot, i) => {
    dot.classList.toggle("spent", i >= left);
  });
}

$("vote-end").addEventListener("click", () => {
  const session = votingSession();
  if (session) store.setMeta("voting", { ...session, active: false });
});

$("btn-vote").addEventListener("click", () => void openVoteDialog());

async function openVoteDialog(): Promise<void> {
  document.getElementById("share-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  const session = votingSession();
  const totals = store.voteTotals();

  if (session?.active) {
    backdrop.innerHTML = `
      <div class="dialog panel" role="dialog">
        <h3>Voting is live</h3>
        <p style="margin:0;font-size:13px;color:#6b7280">
          Everyone has ${session.budget} votes. Click a sticky to vote,
          shift-click to take a vote back.</p>
        <div class="row"><button class="primary" id="v-end">End voting</button>
        <button id="v-close">Close</button></div>
      </div>`;
    backdrop.querySelector("#v-end")!.addEventListener("click", () => {
      store.setMeta("voting", { ...session, active: false });
      backdrop.remove();
    });
  } else if (totals.size > 0) {
    const ranked = [...totals.entries()]
      .map(([id, votes]) => ({ node: store.getNode(id), votes }))
      .filter((r) => r.node)
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 8);
    const list = ranked
      .map((r) => {
        const label = ("text" in r.node! && r.node!.text ? r.node!.text : r.node!.type)
          .replace(/\n/g, " ").slice(0, 40);
        return `<div class="share-row"><span>${label
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span><strong>${r.votes}</strong></div>`;
      })
      .join("");
    backdrop.innerHTML = `
      <div class="dialog panel" role="dialog">
        <h3>Voting results</h3>
        ${list}
        <div class="row">
          <button class="primary" id="v-rank">Rank into table</button>
          <button id="v-again">New round</button>
          <button id="v-clear">Clear</button>
        </div>
      </div>`;
    backdrop.querySelector("#v-rank")!.addEventListener("click", () => {
      rankVotesToTable();
      backdrop.remove();
    });
    backdrop.querySelector("#v-again")!.addEventListener("click", () => {
      store.clearVotes();
      backdrop.remove();
      void openVoteDialog();
    });
    backdrop.querySelector("#v-clear")!.addEventListener("click", () => {
      store.clearVotes();
      backdrop.remove();
    });
  } else {
    backdrop.innerHTML = `
      <div class="dialog panel" role="dialog">
        <h3>Start voting</h3>
        <label style="font-size:13px;color:#6b7280">Votes per person
          <input id="v-budget" type="number" min="1" max="10" value="3" style="width:100%" />
        </label>
        <div class="row"><button class="primary" id="v-start">Start</button>
        <button id="v-close">Close</button></div>
      </div>`;
    backdrop.querySelector("#v-start")!.addEventListener("click", () => {
      const budget = Math.max(1, Math.min(10,
        Number((backdrop.querySelector("#v-budget") as HTMLInputElement).value) || 3));
      store.setMeta("voting", { active: true, budget, startedBy: me.name });
      backdrop.remove();
      toast(`Voting started — ${budget} votes each. Click a sticky to vote.`);
    });
  }
  backdrop.querySelector("#v-close")?.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  for (const input of backdrop.querySelectorAll("input")) {
    input.addEventListener("keydown", (e) => e.stopPropagation());
  }
  document.body.appendChild(backdrop);
}

/** Votes → a bound, ranked table beside the voted content. */
function rankVotesToTable(): void {
  const ranked = [...store.voteTotals().entries()]
    .map(([id, votes]) => ({ node: store.getNode(id), votes }))
    .filter((r): r is { node: NonNullable<typeof r.node>; votes: number } => !!r.node)
    .sort((a, b) => b.votes - a.votes);
  if (!ranked.length) return;
  const columns = [
    { id: "c0", name: "Item", w: 260 },
    { id: "c1", name: "Votes", w: 100 },
  ];
  const rows = ranked.map((r, i) => ({
    id: `r${i}`,
    cells: {
      c0: "text" in r.node && r.node.text ? r.node.text : r.node.type,
      c1: String(r.votes),
    },
  }));
  const right = Math.max(...ranked.map((r) => r.node.x + r.node.w));
  const top = Math.min(...ranked.map((r) => r.node.y));
  const pos = findEmptySpace([...store.nodes.values()], 360, (rows.length + 1) * 34, {
    x: right + 120, y: top,
  });
  const tableId = newId();
  store.transact(() => {
    store.upsertNode({
      id: tableId, type: "table", parent: null,
      x: pos.x, y: pos.y, w: 360, h: (rows.length + 1) * 34,
      rotation: 0, index: store.topIndex(), locked: false, data: {},
      title: "Vote results", columns, rows,
    });
    ranked.forEach((r, i) => {
      store.updateNode(r.node.id, {
        data: { ...r.node.data, $source: { table: tableId, row: `r${i}`, column: "c0" } },
      });
    });
  });
  editor.selectOnly(tableId);
  const table = store.getNode(tableId);
  if (table) {
    camera.x = table.x + table.w / 2 - window.innerWidth / 2 / camera.zoom;
    camera.y = table.y + table.h / 2 - window.innerHeight / 2 / camera.zoom;
  }
  toast(`Ranked ${rows.length} items into a table, bound to their stickies.`);
  dirty = true;
}

// --- shared timer ------------------------------------------------------------

interface TimerState { endsAt: number; duration: number; startedBy: string }
let timerChimed = false;

function updateTimerBar(): void {
  const timer = store.getMeta<TimerState>("timer");
  const bar = $("timerbar");
  if (!timer) {
    bar.classList.remove("active", "urgent");
    timerChimed = false;
    return;
  }
  bar.classList.add("active");
  const left = timer.endsAt - Date.now();
  const clamped = Math.max(0, Math.ceil(left / 1000));
  $("timer-time").textContent = `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
  bar.classList.toggle("urgent", left <= 10_000 && left > 0);
  if (left <= 0) {
    bar.classList.remove("urgent");
    $("timer-time").textContent = "Time's up";
    if (!timerChimed) {
      timerChimed = true;
      chime();
    }
  }
}
setInterval(updateTimerBar, 250);

function chime(): void {
  try {
    const ac = new AudioContext();
    for (const [freq, at] of [[880, 0], [1108.7, 0.18]] as const) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ac.destination);
      gain.gain.setValueAtTime(0.0001, ac.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + 0.5);
      osc.start(ac.currentTime + at);
      osc.stop(ac.currentTime + at + 0.55);
    }
  } catch { /* audio not allowed yet */ }
}

$("timer-stop").addEventListener("click", () => store.setMeta("timer", undefined));

$("btn-timer").addEventListener("click", () => {
  document.querySelector(".dialog-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.innerHTML = `
    <div class="dialog panel" role="dialog">
      <h3>Shared timer</h3>
      <p style="margin:0;font-size:13px;color:#6b7280">Everyone on the board sees the countdown.</p>
      <div class="row" id="timer-presets"></div>
      <div class="row">
        <input id="timer-custom" type="number" min="1" max="120" placeholder="Minutes" />
        <button class="primary" id="timer-go">Start</button>
      </div>
    </div>`;
  const start = (minutes: number) => {
    store.setMeta("timer", {
      endsAt: Date.now() + minutes * 60_000,
      duration: minutes * 60_000,
      startedBy: me.name,
    } satisfies TimerState);
    timerChimed = false;
    backdrop.remove();
  };
  const presets = backdrop.querySelector("#timer-presets")!;
  for (const m of [1, 2, 5, 10]) {
    const b = document.createElement("button");
    b.textContent = `${m} min`;
    b.addEventListener("click", () => start(m));
    presets.appendChild(b);
  }
  backdrop.querySelector("#timer-go")!.addEventListener("click", () => {
    const m = Number((backdrop.querySelector("#timer-custom") as HTMLInputElement).value);
    if (m >= 1) start(Math.min(120, m));
  });
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  for (const input of backdrop.querySelectorAll("input")) {
    input.addEventListener("keydown", (e) => e.stopPropagation());
  }
  document.body.appendChild(backdrop);
});

// --- private drafts ----------------------------------------------------------

const DRAFTS_KEY = `orim-drafts-${BOARD}`;
let lastRevealAsk = 0;

function loadDrafts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveDrafts(drafts: string[]): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch { /* private mode */ }
  renderDrafts();
}

function renderDrafts(): void {
  const drafts = loadDrafts();
  const list = $("drafts-list");
  list.replaceChildren();
  drafts.forEach((text, i) => {
    const row = document.createElement("div");
    row.className = "draft";
    const span = document.createElement("span");
    span.textContent = text;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.setAttribute("aria-label", "Delete draft");
    del.addEventListener("click", () => {
      const next = loadDrafts();
      next.splice(i, 1);
      saveDrafts(next);
    });
    row.append(span, del);
    list.appendChild(row);
  });
  $("drafts-label").textContent = drafts.length ? `Drafts · ${drafts.length}` : "Drafts";
}

function publishDrafts(): void {
  const drafts = loadDrafts();
  if (!drafts.length) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(drafts.length)));
  const blockW = cols * 204;
  const blockH = Math.ceil(drafts.length / cols) * 144;
  const center = toWorld(camera, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const pos = findEmptySpace([...store.nodes.values()], blockW, blockH, {
    x: center.x - blockW / 2,
    y: center.y - blockH / 2,
  });
  store.transact(() => {
    drafts.forEach((text, i) => {
      store.upsertNode({
        id: newId(), type: "sticky", parent: null,
        x: pos.x + (i % cols) * 204,
        y: pos.y + Math.floor(i / cols) * 144,
        w: 180, h: 120,
        rotation: 0, index: store.topIndex(), locked: false,
        data: { draftedBy: me.name },
        text, color: defaultColor, author: me.name,
      });
    });
  });
  saveDrafts([]);
  toast(`Revealed ${drafts.length} draft${drafts.length === 1 ? "" : "s"}.`);
  dirty = true;
}

$("btn-drafts").addEventListener("click", () => {
  const open = !$("drafts-panel").classList.contains("open");
  $("drafts-panel").classList.toggle("open", open);
  $("btn-drafts").classList.toggle("active", open);
  if (open) ($("draft-input") as HTMLInputElement).focus();
});
$("draft-input").addEventListener("keydown", (e) => {
  e.stopPropagation();
  const input = e.target as HTMLInputElement;
  if (e.key === "Enter" && input.value.trim()) {
    saveDrafts([...loadDrafts(), input.value.trim()]);
    input.value = "";
  }
  if (e.key === "Escape") $("btn-drafts").click();
});
$("drafts-reveal").addEventListener("click", publishDrafts);
$("drafts-reveal-all").addEventListener("click", () => {
  store.setMeta("revealAsk", { at: Date.now(), by: me.name });
  toast("Asked everyone to reveal their drafts.");
});

/** When anyone broadcasts a reveal, clients holding drafts publish them. */
function checkRevealAsk(): void {
  const ask = store.getMeta<{ at: number; by: string }>("revealAsk");
  if (!ask || ask.at <= lastRevealAsk) return;
  lastRevealAsk = ask.at;
  if (loadDrafts().length && !readOnly) {
    publishDrafts();
    toast(`${ask.by} asked everyone to reveal — your drafts are on the board.`);
  }
}
lastRevealAsk = store.getMeta<{ at: number }>("revealAsk")?.at ?? 0;
renderDrafts();

// --- export ------------------------------------------------------------------

const exportBtn = $("btn-export");
const exportMenu = $("export-menu");
exportBtn.prepend(createElement(Download, { width: 17, height: 17, "stroke-width": 1.75 }));

function exportBoard(): ExportBoard {
  return {
    title: BOARD.replace(/^orim-/, ""),
    nodes: [...store.nodes.values()],
    connectors: [...store.connectors.values()],
    comments: [...store.comments.values()],
    votes: Object.fromEntries(store.voteTotals()),
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

let voteTotals: Map<string, number> | null = null;
let voteTotalsRev = -1;
function voteTotalsCached(): Map<string, number> | null {
  if (voteTotalsRev !== store.revision) {
    const totals = store.voteTotals();
    voteTotals = totals.size ? totals : null;
    voteTotalsRev = store.revision;
  }
  return voteTotals;
}

// --- render loop -------------------------------------------------------------

let frames = 0;
let fpsWindowStart = performance.now();
let lastMinimap = 0;

function frame(): void {
  // While time-travelling, the scene renders the historical store;
  // live-only affordances (presence, comments, votes, links) hide.
  const src = historyStore ?? store;
  const dataLinks = historyStore ? [] : computeDataLinks();
  if (dirty || presences.length > 0 || overlay.activeId || dataLinks.length) {
    renderer.render({
      nodesSorted: src.nodesSorted,
      connectors: src.connectors,
      getNode: (id) => src.getNode(id),
      camera,
      selection: editor.selection,
      connectorSelection: editor.connectorSelection,
      editingId: overlay.activeId,
      presences: historyStore ? [] : presences,
      revision: src.revision,
      dataLinks,
      timestamp: performance.now(),
      portsFor:
        editor.tool === "select" || editor.tool === "connector"
          ? editor.hoveredId ?? editor.singleSelectedNode()?.id ?? null
          : null,
      bindCell: editor.draftBindCell,
      colorRules: src.getMeta<import("@orim/editor").ColorRule[]>("colorRules") ?? [],
      treePlusFor: (() => {
        if (readOnly || editor.tool !== "select") return null;
        const n = editor.singleSelectedNode();
        return n && n.type !== "frame" && n.type !== "ink" && editor.isTreeMember(n.id)
          ? n.id
          : null;
      })(),
      comments: historyStore ? [] : comments.visible(),
      activeCommentId: comments.activeId,
      votes: historyStore ? null : voteTotalsCached(),
      marquee: editor.marquee,
      draftRect: editor.draftRect,
      draftConnector: editor.draftConnector,
      draftInk: editor.draftInk,
      draftColor: PALETTE[defaultColor].solid,
    });
    overlay.reposition(camera);
    embeds.sync(src.nodesSorted, camera, historyStore ? undefined : editor.selection);
    comments.reposition();
    dirty = false;
  }

  const now = performance.now();
  if (now - lastMinimap > 250) {
    minimapTransform = renderer.renderMinimap(
      minimapCanvas,
      { nodesSorted: src.nodesSorted, camera },
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

// Stats (fps, object count) are developer telemetry: hidden by default,
// toggled by clicking the status chip, remembered per device.
const statExtra = $("stat-extra");
statExtra.hidden = localStorage.getItem("orim-stats") !== "1";
$("statusbar").dataset.tip = "Connection — click for stats";
$("statusbar").dataset.tipAt = "top";
$("statusbar").removeAttribute("title");
$("statusbar").addEventListener("click", () => {
  statExtra.hidden = !statExtra.hidden;
  try {
    localStorage.setItem("orim-stats", statExtra.hidden ? "0" : "1");
  } catch { /* private mode */ }
});

syncToolbar();
setupTooltips();
updateVoteBar();
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
