import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { BoardStore } from "@orim/store";
import type { PaletteColor } from "@orim/schema";
import {
  Editor, cameraToFit, toScreen, toWorld, zoomAt, type Camera, type ToolName,
} from "@orim/editor";
import {
  Renderer, PALETTE, PALETTE_KEYS, CURSOR_COLORS, type PresenceState,
} from "@orim/renderer";
import { TextEditorOverlay, isEditable } from "./editor-overlay";
import {
  createElement, MousePointer2, Hand, StickyNote, Square, Circle, Diamond,
  Type, Frame, MoveUpRight, Pencil, type IconNode,
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
  openTextEditor: (node) => {
    if (node.type === "frame") {
      openFrameTitleEditor(node);
    } else if (isEditable(node)) {
      overlay.open(node, camera, (text) => store.updateNode(node.id, { text }));
    }
    dirty = true;
  },
});

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
});

// --- pointer -----------------------------------------------------------------

const info = (e: PointerEvent | MouseEvent) => ({
  world: toWorld(camera, { x: e.clientX, y: e.clientY }),
  screen: { x: e.clientX, y: e.clientY },
  shiftKey: e.shiftKey,
});

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
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
  dirty = true;
});

canvas.addEventListener("pointerup", (e) => {
  editor.pointerUp(info(e));
  syncToolbar();
  dirty = true;
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
  d: "diamond", t: "text", f: "frame", c: "connector", p: "ink",
};

window.addEventListener("keydown", (e) => {
  if (overlay.activeId) return; // ProseMirror owns the keyboard while editing
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
    } else if (key === "v") {
      e.preventDefault();
      editor.paste();
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
  } else if (TOOL_KEYS[key]) {
    editor.tool = TOOL_KEYS[key]!;
  }
  syncToolbar();
  dirty = true;
});

window.addEventListener("resize", () => {
  renderer.resize();
  dirty = true;
});

// --- toolbar -----------------------------------------------------------------

const TOOL_ICONS: Record<string, IconNode> = {
  select: MousePointer2, hand: Hand, sticky: StickyNote, rect: Square,
  ellipse: Circle, diamond: Diamond, text: Type, frame: Frame,
  connector: MoveUpRight, ink: Pencil,
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
    btn.classList.toggle("active", btn.dataset.tool === editor.tool);
  }
}

const colorsEl = $("colors");
for (const key of PALETTE_KEYS) {
  const btn = document.createElement("button");
  btn.style.background = PALETTE[key].fill;
  btn.title = key;
  btn.classList.toggle("active", key === defaultColor);
  btn.addEventListener("click", () => {
    defaultColor = key;
    for (const b of colorsEl.children) b.classList.toggle("active", b === btn);
    editor.setSelectionColor(key);
    dirty = true;
  });
  colorsEl.appendChild(btn);
}

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
  if (dirty || presences.length > 0 || overlay.activeId) {
    renderer.render({
      nodesSorted: store.nodesSorted,
      connectors: store.connectors,
      getNode: (id) => store.getNode(id),
      camera,
      selection: editor.selection,
      connectorSelection: editor.connectorSelection,
      editingId: overlay.activeId,
      presences,
      marquee: editor.marquee,
      draftRect: editor.draftRect,
      draftConnector: editor.draftConnector,
      draftInk: editor.draftInk,
      draftColor: PALETTE[defaultColor].solid,
    });
    overlay.reposition(camera);
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
    orim: { store: BoardStore; camera: Camera; editor: Editor };
  }
}
window.orim = { store, camera, editor };
