import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { BoardStore } from "@orim/store";
import type { Node, StickyNode } from "@orim/schema";
import { Renderer, type PresenceState } from "./renderer";
import { TextEditorOverlay } from "./editor-overlay";
import { toWorld, zoomAt, type Camera } from "./camera";
import { PALETTE_KEYS, CURSOR_COLORS } from "./colors";

const STICKY_W = 180;
const STICKY_H = 120;

// --- state ------------------------------------------------------------------

const doc = new Y.Doc();
const store = new BoardStore(doc);
const camera: Camera = { x: -60, y: -60, zoom: 1 };
const selection = new Set<string>();
let presences: PresenceState[] = [];
let dirty = true;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlayRoot = document.getElementById("overlay-root") as HTMLElement;
const renderer = new Renderer(canvas);
const editor = new TextEditorOverlay(overlayRoot);

const $ = (id: string) => document.getElementById(id) as HTMLElement;

// --- sync -------------------------------------------------------------------

const provider = new HocuspocusProvider({
  url: "ws://localhost:1234",
  name: "orim-spike",
  document: doc,
  token: "guest",
  onStatus: ({ status }) => {
    $("stat-conn").textContent = status;
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

// --- helpers ----------------------------------------------------------------

let nextId = 0;
const newId = () => `${doc.clientID.toString(36)}-${(nextId++).toString(36)}-${Date.now().toString(36)}`;

function makeSticky(x: number, y: number, text = "", color?: StickyNode["color"]): StickyNode {
  return {
    id: newId(),
    type: "sticky",
    parent: null,
    x, y,
    w: STICKY_W,
    h: STICKY_H,
    rotation: 0,
    index: "a0",
    locked: false,
    data: {},
    text,
    color: color ?? PALETTE_KEYS[Math.floor(Math.random() * PALETTE_KEYS.length)]!,
    author: me.name,
  };
}

function hitTest(wx: number, wy: number): Node | null {
  let hit: Node | null = null;
  for (const node of store.nodes.values()) {
    if (wx >= node.x && wx <= node.x + node.w && wy >= node.y && wy <= node.y + node.h) {
      hit = node; // last wins ≈ topmost for the spike
    }
  }
  return hit;
}

// --- input ------------------------------------------------------------------

type DragMode =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startY: number; camX: number; camY: number }
  | { kind: "move"; id: string; dx: number; dy: number };

let drag: DragMode = { kind: "none" };

canvas.addEventListener("pointerdown", (e) => {
  if (editor.activeId) {
    const w = toWorld(camera, { x: e.clientX, y: e.clientY });
    if (hitTest(w.x, w.y)?.id === editor.activeId) return; // click inside the open editor
    editor.close(true); // commit, then continue with this pointer action
    dirty = true;
  }
  canvas.setPointerCapture(e.pointerId);
  const w = toWorld(camera, { x: e.clientX, y: e.clientY });
  const hit = hitTest(w.x, w.y);
  selection.clear();
  if (hit) {
    selection.add(hit.id);
    drag = { kind: "move", id: hit.id, dx: w.x - hit.x, dy: w.y - hit.y };
  } else {
    drag = { kind: "pan", startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
  }
  dirty = true;
});

canvas.addEventListener("pointermove", (e) => {
  const w = toWorld(camera, { x: e.clientX, y: e.clientY });
  awareness?.setLocalStateField("cursor", { x: w.x, y: w.y });

  if (drag.kind === "pan") {
    camera.x = drag.camX - (e.clientX - drag.startX) / camera.zoom;
    camera.y = drag.camY - (e.clientY - drag.startY) / camera.zoom;
    dirty = true;
  } else if (drag.kind === "move") {
    store.updateNode(drag.id, { x: w.x - drag.dx, y: w.y - drag.dy });
  }
});

canvas.addEventListener("pointerup", () => {
  drag = { kind: "none" };
});

canvas.addEventListener("dblclick", (e) => {
  const w = toWorld(camera, { x: e.clientX, y: e.clientY });
  const hit = hitTest(w.x, w.y);
  if (hit && hit.type === "sticky") {
    openEditor(hit);
  } else if (!hit) {
    const sticky = makeSticky(w.x - STICKY_W / 2, w.y - STICKY_H / 2);
    store.upsertNode(sticky);
    selection.clear();
    selection.add(sticky.id);
    openEditor(sticky);
  }
});

function openEditor(node: StickyNode): void {
  editor.open(node, camera, (text) => store.updateNode(node.id, { text }));
  dirty = true;
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const next = zoomAt(camera, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.01));
      camera.x = next.x; camera.y = next.y; camera.zoom = next.zoom;
    } else {
      camera.x += e.deltaX / camera.zoom;
      camera.y += e.deltaY / camera.zoom;
    }
    dirty = true;
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (editor.activeId) return; // ProseMirror owns the keyboard while editing
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "z") {
    e.preventDefault();
    if (e.shiftKey) store.undo.redo();
    else store.undo.undo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selection.size) {
    e.preventDefault();
    store.transact(() => {
      for (const id of selection) store.deleteNode(id);
    });
    selection.clear();
  }
});

window.addEventListener("resize", () => {
  renderer.resize();
  dirty = true;
});

// --- HUD --------------------------------------------------------------------

$("btn-seed").addEventListener("click", () => {
  const cols = 125;
  const gapX = STICKY_W + 24;
  const gapY = STICKY_H + 24;
  const words = ["idea", "risk", "ship it", "why?", "blocked on infra", "talk to users", "v2", "cut scope", "measure", "yes and"];
  store.transact(() => {
    for (let i = 0; i < 10_000; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const sticky = makeSticky(
        col * gapX,
        row * gapY,
        `${words[i % words.length]} #${i}`,
      );
      store.upsertNode(sticky);
    }
  });
});

$("btn-clear").addEventListener("click", () => {
  store.transact(() => {
    for (const id of [...store.nodes.keys()]) store.deleteNode(id);
  });
  selection.clear();
});

// --- render loop ------------------------------------------------------------

let frames = 0;
let fpsWindowStart = performance.now();

function frame(): void {
  // Presence cursors move every frame; render unconditionally while others
  // are connected, otherwise only when dirty.
  if (dirty || presences.length > 0 || editor.activeId) {
    const { visible } = renderer.render({
      nodes: store.nodes,
      camera,
      selection,
      editingId: editor.activeId,
      presences,
    });
    editor.reposition(camera);
    $("stat-visible").textContent = String(visible);
    dirty = false;
  }

  frames++;
  const now = performance.now();
  if (now - fpsWindowStart >= 500) {
    $("stat-fps").textContent = String(Math.round((frames * 1000) / (now - fpsWindowStart)));
    $("stat-nodes").textContent = String(store.nodes.size);
    $("stat-zoom").textContent = `${Math.round(camera.zoom * 100)}%`;
    frames = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Debug handle for spike verification (dropped in the real app).
declare global {
  interface Window {
    orim: { store: BoardStore; camera: Camera; makeSticky: typeof makeSticky };
  }
}
window.orim = { store, camera, makeSticky };
