/**
 * The start page: board gallery with live mini-previews (from the sync
 * server's HTTP API), templates, and board management (rename/delete).
 * Falls back to locally-remembered boards when the server is offline.
 */
import { PALETTE, CANVAS_BG } from "@orim/renderer";
import { TEMPLATES } from "@orim/convert";
import type { PaletteColor } from "@orim/schema";

const API = "http://localhost:1234";

interface BoardInfo {
  name: string;
  updatedAt: number;
  count: number;
  nodes: { x: number; y: number; w: number; h: number; type: string; color: PaletteColor | null }[];
}

const timeAgo = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
  `board-${Date.now().toString(36)}`;

const openBoard = (name: string, template?: string): void => {
  const params = new URLSearchParams({ b: name });
  if (template) params.set("template", template);
  location.href = `/?${params}`;
};

function recents(): { name: string; at: number }[] {
  try {
    return JSON.parse(localStorage.getItem("orim-recents") ?? "[]");
  } catch {
    return [];
  }
}

function drawPreview(canvas: HTMLCanvasElement, info: BoardInfo): void {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, W, H);
  if (!info.nodes.length) return;
  const minX = Math.min(...info.nodes.map((n) => n.x));
  const minY = Math.min(...info.nodes.map((n) => n.y));
  const maxX = Math.max(...info.nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...info.nodes.map((n) => n.y + n.h));
  const pad = 14;
  const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY), 0.5);
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (H - (maxY - minY) * scale) / 2 - minY * scale;
  for (const n of info.nodes) {
    if (n.type === "frame") {
      ctx.fillStyle = "#FFFFFF";
      ctx.strokeStyle = "#D6D6D2";
    } else {
      ctx.fillStyle = n.color ? PALETTE[n.color].fill : "#E5E7EB";
      ctx.strokeStyle = "transparent";
    }
    const x = n.x * scale + ox;
    const y = n.y * scale + oy;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(2, n.w * scale), Math.max(2, n.h * scale), 1.5);
    ctx.fill();
    if (n.type === "frame") ctx.stroke();
  }
}

export async function renderStartPage(): Promise<void> {
  document.title = "Orim — Boards";
  const root = document.createElement("div");
  root.id = "start";
  root.innerHTML = `
    <header>
      <img src="/orim.svg" alt="Orim" />
      <button id="new-board" class="primary">New board</button>
    </header>
    <section>
      <h2>Start from a template</h2>
      <div id="template-row"></div>
    </section>
    <section>
      <h2>Boards</h2>
      <div id="board-grid"><div class="hint">Loading…</div></div>
    </section>
  `;
  document.body.replaceChildren(root);

  root.querySelector("#new-board")!.addEventListener("click", () => {
    const name = prompt("Board name");
    if (name !== null) openBoard(slugify(name));
  });

  const templateRow = root.querySelector("#template-row")!;
  for (const t of TEMPLATES) {
    const card = document.createElement("button");
    card.className = "template-card";
    card.innerHTML = `<strong></strong><span></span>`;
    card.querySelector("strong")!.textContent = t.name;
    card.querySelector("span")!.textContent = t.description;
    card.addEventListener("click", () => {
      const name = prompt(`Board name for "${t.name}"`, t.id);
      if (name !== null) openBoard(slugify(name), t.id);
    });
    templateRow.appendChild(card);
  }

  const grid = root.querySelector("#board-grid")!;
  let boards: BoardInfo[] = [];
  try {
    const res = await fetch(`${API}/boards`);
    boards = (await res.json()) as BoardInfo[];
  } catch {
    boards = recents()
      .sort((a, b) => b.at - a.at)
      .map((r) => ({ name: r.name, updatedAt: r.at, count: 0, nodes: [] }));
    if (boards.length) {
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = "Sync server offline — showing boards you've opened on this device.";
      grid.before(note);
    }
  }

  grid.replaceChildren();
  if (!boards.length) {
    grid.innerHTML = `<div class="hint">No boards yet — create one above.</div>`;
    return;
  }
  for (const info of boards) {
    const card = document.createElement("div");
    card.className = "board-card";
    const preview = document.createElement("canvas");
    preview.width = 248;
    preview.height = 140;
    drawPreview(preview, info);
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = info.name;
    const sub = document.createElement("span");
    sub.textContent = `${info.count} objects · ${timeAgo(info.updatedAt)}`;
    meta.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const to = prompt("Rename board", info.name);
      if (!to || slugify(to) === info.name) return;
      await fetch(`${API}/boards/rename?from=${encodeURIComponent(info.name)}&to=${encodeURIComponent(slugify(to))}`, { method: "POST" });
      location.reload();
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${info.name}"? This can't be undone.`)) return;
      await fetch(`${API}/boards?name=${encodeURIComponent(info.name)}`, { method: "DELETE" });
      try {
        indexedDB.deleteDatabase(`orim-${info.name}`);
      } catch { /* best effort */ }
      location.reload();
    });
    actions.append(renameBtn, deleteBtn);

    card.append(preview, meta, actions);
    card.addEventListener("click", () => openBoard(info.name));
    grid.appendChild(card);
  }
}
