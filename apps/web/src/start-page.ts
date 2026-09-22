/**
 * The start page: board gallery with live mini-previews (from the sync
 * server's HTTP API), templates, and board management (rename/delete).
 * Falls back to locally-remembered boards when the server is offline.
 */
import { PALETTE, CANVAS_BG } from "@orim/renderer";
import { TEMPLATES } from "@orim/convert";
import type { PaletteColor } from "@orim/schema";
import { API, authHeaders, authName, openAuthDialog, signOut } from "./auth";

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

interface PreviewNode {
  x: number; y: number; w: number; h: number;
  type: string; color: PaletteColor | null;
}

function drawPreview(canvas: HTMLCanvasElement, nodes: PreviewNode[]): void {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);
  // A whisper of the dot grid, so previews read as canvas.
  ctx.fillStyle = "rgba(31, 36, 48, 0.05)";
  for (let x = 10; x < W; x += 22) {
    for (let y = 10; y < H; y += 22) ctx.fillRect(x, y, 1.5, 1.5);
  }
  if (!nodes.length) return;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const pad = 16;
  const scale = Math.min(
    (W - pad * 2) / Math.max(1, maxX - minX),
    (H - pad * 2) / Math.max(1, maxY - minY),
    0.5,
  );
  const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (H - (maxY - minY) * scale) / 2 - minY * scale;
  for (const n of nodes) {
    const x = n.x * scale + ox;
    const y = n.y * scale + oy;
    const w = Math.max(2.5, n.w * scale);
    const h = Math.max(2.5, n.h * scale);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 2);
    if (n.type === "table") {
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.strokeStyle = "#CFCFCA";
      ctx.stroke();
      const headerH = Math.max(3, Math.min(7, h * 0.25));
      ctx.fillStyle = "#E9E9E6";
      ctx.fillRect(x, y, w, headerH);
      ctx.strokeStyle = "#E3E3DF";
      ctx.beginPath();
      for (let ly = y + headerH * 2; ly < y + h - 2; ly += headerH) {
        ctx.moveTo(x, ly);
        ctx.lineTo(x + w, ly);
      }
      ctx.stroke();
    } else if (n.type === "frame") {
      ctx.fillStyle = CANVAS_BG;
      ctx.fill();
      ctx.strokeStyle = "#D6D6D2";
      ctx.stroke();
    } else {
      ctx.fillStyle = n.color ? PALETTE[n.color].fill : "#DDE1E6";
      ctx.fill();
    }
  }
}

export async function renderStartPage(): Promise<void> {
  document.title = "Orim — Boards";
  const root = document.createElement("div");
  root.id = "start";
  root.innerHTML = `
    <header>
      <img src="/orim.svg" alt="Orim" />
      <div class="header-actions">
        <span id="account-name"></span>
        <button id="account-btn"></button>
        <button id="new-board" class="primary">New board</button>
      </div>
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

  const accountBtn = root.querySelector<HTMLButtonElement>("#account-btn")!;
  const accountName = root.querySelector<HTMLElement>("#account-name")!;
  const who = authName();
  accountName.textContent = who ?? "";
  accountBtn.textContent = who ? "Sign out" : "Sign in";
  accountBtn.addEventListener("click", () => {
    if (authName()) {
      void signOut().then(() => location.reload());
    } else {
      void openAuthDialog().then((name) => {
        if (name) location.reload();
      });
    }
  });

  const templateRow = root.querySelector("#template-row")!;
  for (const t of TEMPLATES) {
    const card = document.createElement("button");
    card.className = "card template-card";
    // Each template card previews what the template actually builds.
    let i = 0;
    const built = t.build(() => `t${i++}`);
    const preview = document.createElement("canvas");
    preview.width = 480;
    preview.height = 256;
    drawPreview(
      preview,
      built.nodes.map((n) => ({
        x: n.x, y: n.y, w: n.w, h: n.h, type: n.type,
        color: "color" in n ? n.color : null,
      })),
    );
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = t.name;
    const desc = document.createElement("span");
    desc.textContent = t.description;
    meta.append(title, desc);
    card.append(preview, meta);
    card.addEventListener("click", () => {
      const name = prompt(`Board name for "${t.name}"`, t.id);
      if (name !== null) openBoard(slugify(name), t.id);
    });
    templateRow.appendChild(card);
  }

  const grid = root.querySelector("#board-grid")!;
  let boards: BoardInfo[] = [];
  try {
    const res = await fetch(`${API}/boards`, { headers: authHeaders() });
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
    card.className = "card board-card";
    const preview = document.createElement("canvas");
    preview.width = 496;
    preview.height = 280;
    drawPreview(preview, info.nodes);
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
      const r = await fetch(
        `${API}/boards/rename?from=${encodeURIComponent(info.name)}&to=${encodeURIComponent(slugify(to))}`,
        { method: "POST", headers: authHeaders() },
      );
      if (!r.ok) alert("Only the board's owner can rename it.");
      location.reload();
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${info.name}"? This can't be undone.`)) return;
      const r = await fetch(`${API}/boards?name=${encodeURIComponent(info.name)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!r.ok) alert("Only the board's owner can delete it.");
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
