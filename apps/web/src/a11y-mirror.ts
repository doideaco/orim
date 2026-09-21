/**
 * The accessibility mirror: a hidden, ordered DOM tree generated from the
 * scene graph. Reading order is the same `orderBoard` pass exports use, so
 * what a screen reader hears is what the Markdown export says.
 *
 * - ARIA tree with roving tabindex; arrows navigate, Left/Right collapse
 *   and expand frames and tables, Home/End jump.
 * - Selection follows focus, and the camera jumps to the focused object,
 *   so keyboard users get the same spatial context as pointer users.
 * - Enter opens the real text editor (a contenteditable, itself
 *   accessible); closing it returns focus to the tree.
 * - A polite live region announces additions, removals and text changes —
 *   including edits arriving from collaborators and agents.
 */
import type { Connector, Node, TableNode } from "@orim/schema";
import { orderBoard, nodeLabel, type ExportBoard } from "@orim/convert";
import type { BoardStore } from "@orim/store";
import type { Camera, Editor } from "@orim/editor";

function describe(n: Node): string {
  switch (n.type) {
    case "sticky":
      return `Sticky note: ${n.text || "empty"}, ${n.color}`;
    case "shape":
      return `${n.kind} shape: ${n.text || "no text"}, ${n.color}`;
    case "text":
      return `Text: ${n.text || "empty"}`;
    case "ink":
      return "Drawing";
    case "table":
      return `Table "${n.title}": ${n.rows.length} rows, ${n.columns.length} columns`;
    case "frame":
      return `Frame "${n.title}"`;
  }
}

export class A11yMirror {
  private root: HTMLElement;
  private tree: HTMLElement;
  private announcer: HTMLElement;
  private collapsed = new Set<string>();
  private focusedId: string | null = null;
  private pendingRefocus: string | null = null;
  private prevLabels = new Map<string, string>();
  private pendingAnnouncements: string[] = [];
  private announceTimer: number | null = null;
  private scheduled = false;

  constructor(
    private store: BoardStore,
    private editor: Editor,
    private camera: Camera,
    private hooks: {
      onChange(): void;
      openEditor(node: Node): void;
      overlayRoot: HTMLElement;
    },
  ) {
    this.root = document.createElement("nav");
    this.root.id = "a11y-mirror";
    this.root.className = "sr-only";
    this.root.setAttribute("aria-label", "Board contents");
    this.tree = document.createElement("div");
    this.tree.setAttribute("role", "tree");
    this.tree.setAttribute("aria-label", "Board contents");
    this.root.appendChild(this.tree);

    this.announcer = document.createElement("div");
    this.announcer.className = "sr-only";
    this.announcer.setAttribute("aria-live", "polite");
    this.announcer.setAttribute("aria-atomic", "false");

    document.body.prepend(this.announcer);
    document.body.prepend(this.root);

    this.tree.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.tree.addEventListener("focusin", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
      if (item) this.onItemFocused(item.dataset.nodeId!);
    });

    // When the text editor the tree opened goes away, focus comes home.
    new MutationObserver(() => {
      if (this.pendingRefocus && !this.hooks.overlayRoot.hasChildNodes()) {
        const id = this.pendingRefocus;
        this.pendingRefocus = null;
        this.focusItem(id);
      }
    }).observe(this.hooks.overlayRoot, { childList: true });

    this.store.subscribe(() => {
      this.diffAndAnnounce();
      this.scheduleRebuild();
    });
    this.rebuild();
  }

  // --- announcements ---------------------------------------------------------

  private diffAndAnnounce(): void {
    const current = new Map<string, string>();
    for (const n of this.store.nodes.values()) current.set(n.id, describe(n));
    for (const c of this.store.connectors.values()) {
      current.set(c.id, this.connectorLabel(c));
    }
    for (const c of this.store.comments.values()) {
      if (c.resolved) continue;
      const replies = c.replies.length ? `, ${c.replies.length} replies` : "";
      current.set(c.id, `Comment by ${c.author}: ${c.body.slice(0, 80)}${replies}`);
    }
    const messages: string[] = [];
    for (const [id, label] of current) {
      const prev = this.prevLabels.get(id);
      if (prev === undefined) messages.push(`Added: ${label}`);
      else if (prev !== label) messages.push(`Changed: ${label}`);
    }
    for (const [id, label] of this.prevLabels) {
      if (!current.has(id)) messages.push(`Removed: ${label}`);
    }
    this.prevLabels = current;
    if (!messages.length) return;
    this.pendingAnnouncements.push(
      ...(messages.length > 3
        ? [...messages.slice(0, 2), `and ${messages.length - 2} more changes`]
        : messages),
    );
    if (this.announceTimer === null) {
      this.announceTimer = window.setTimeout(() => {
        this.announcer.textContent = this.pendingAnnouncements.join(". ");
        this.pendingAnnouncements = [];
        this.announceTimer = null;
      }, 400);
    }
  }

  private connectorLabel(c: Connector): string {
    const end = (e: Connector["from"]): string => {
      if ("point" in e) return "a point";
      const n = this.store.getNode(e.node);
      if (!n) return "a removed object";
      if (e.row && n.type === "table") {
        const row = n.rows.find((r) => r.id === e.row);
        const first = row ? Object.values(row.cells).find(Boolean) : undefined;
        if (first) return `row "${first}" of "${nodeLabel(n)}"`.replace(/\n/g, " ");
      }
      return `"${nodeLabel(n).replace(/\n/g, " ")}"`;
    };
    const label = c.label ? `, labeled "${c.label}"` : "";
    return `Connector from ${end(c.from)} to ${end(c.to)}${label}`;
  }

  // --- tree building ---------------------------------------------------------

  scheduleRebuild(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.rebuild();
    });
  }

  private rebuild(): void {
    const hadFocus = this.root.contains(document.activeElement);
    const board: ExportBoard = {
      nodes: [...this.store.nodes.values()],
      connectors: [...this.store.connectors.values()],
    };
    const ordered = orderBoard(board);
    this.tree.replaceChildren();

    for (const { frame, children } of ordered.frames) {
      const item = this.makeItem(frame, 1, `${describe(frame)}, ${children.length} items`);
      if (children.length && !this.collapsed.has(frame.id)) {
        const group = document.createElement("div");
        group.setAttribute("role", "group");
        for (const child of children) group.appendChild(this.buildNode(child, 2));
        item.appendChild(group);
      }
      if (children.length) {
        item.setAttribute("aria-expanded", String(!this.collapsed.has(frame.id)));
      }
      this.tree.appendChild(item);
    }
    for (const n of ordered.loose) this.tree.appendChild(this.buildNode(n, 1));

    if (board.connectors.length) {
      const item = document.createElement("div");
      item.setAttribute("role", "treeitem");
      item.setAttribute("aria-level", "1");
      item.dataset.nodeId = "$connections";
      item.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = `Connections, ${board.connectors.length} items`;
      item.appendChild(label);
      item.setAttribute("aria-expanded", String(!this.collapsed.has("$connections")));
      if (!this.collapsed.has("$connections")) {
        const group = document.createElement("div");
        group.setAttribute("role", "group");
        for (const c of board.connectors.values()) {
          const row = document.createElement("div");
          row.setAttribute("role", "treeitem");
          row.setAttribute("aria-level", "2");
          row.dataset.nodeId = c.id;
          row.dataset.connector = "true";
          row.tabIndex = -1;
          row.textContent = this.connectorLabel(c);
          group.appendChild(row);
        }
        item.appendChild(group);
      }
      this.tree.appendChild(item);
    }

    if (!this.tree.hasChildNodes()) {
      const empty = document.createElement("div");
      empty.setAttribute("role", "treeitem");
      empty.setAttribute("aria-level", "1");
      empty.tabIndex = 0;
      empty.textContent = "Board is empty";
      this.tree.appendChild(empty);
      return;
    }

    // Roving tabindex: restore the focused item, else the first one.
    const items = this.items();
    const current =
      (this.focusedId && items.find((i) => i.dataset.nodeId === this.focusedId)) || items[0];
    if (current) {
      current.tabIndex = 0;
      if (hadFocus) current.focus();
    }
  }

  private buildNode(n: Node, level: number): HTMLElement {
    if (n.type === "table") return this.buildTable(n, level);
    return this.makeItem(n, level, describe(n));
  }

  private buildTable(t: TableNode, level: number): HTMLElement {
    const item = this.makeItem(t, level, describe(t));
    if (t.rows.length) {
      item.setAttribute("aria-expanded", String(!this.collapsed.has(t.id)));
      if (!this.collapsed.has(t.id)) {
        const group = document.createElement("div");
        group.setAttribute("role", "group");
        t.rows.forEach((row, i) => {
          const rowEl = document.createElement("div");
          rowEl.setAttribute("role", "treeitem");
          rowEl.setAttribute("aria-level", String(level + 1));
          rowEl.dataset.nodeId = `${t.id}#r${i}`;
          rowEl.tabIndex = -1;
          const cells = t.columns
            .map((c) => `${c.name || c.id}: ${row.cells[c.id] ?? "empty"}`)
            .join(", ");
          rowEl.textContent = `Row ${i + 1} of ${t.rows.length}: ${cells}`;
          group.appendChild(rowEl);
        });
        item.appendChild(group);
      }
    }
    return item;
  }

  private makeItem(n: Node, level: number, text: string): HTMLElement {
    const item = document.createElement("div");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.setAttribute("aria-selected", String(this.editor.selection.has(n.id)));
    item.dataset.nodeId = n.id;
    item.tabIndex = -1;
    const label = document.createElement("span");
    label.textContent = text;
    item.appendChild(label);
    return item;
  }

  // --- keyboard --------------------------------------------------------------

  private items(): HTMLElement[] {
    return [...this.tree.querySelectorAll<HTMLElement>("[role='treeitem']")];
  }

  private onItemFocused(id: string): void {
    this.focusedId = id;
    for (const el of this.items()) el.tabIndex = el.dataset.nodeId === id ? 0 : -1;
    if (id.startsWith("$")) return;
    const baseId = id.split("#")[0]!;
    const node = this.store.getNode(baseId);
    if (node) {
      this.editor.selectOnly(baseId);
      this.jumpTo(node);
    } else if (this.store.getConnector(id)) {
      this.editor.clearSelection();
      this.editor.connectorSelection.add(id);
    }
    this.hooks.onChange();
  }

  private focusItem(id: string): void {
    const el = this.items().find((i) => i.dataset.nodeId === id);
    if (el) {
      el.tabIndex = 0;
      el.focus();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[role='treeitem']");
    if (!target) return;
    const items = this.items();
    const index = items.indexOf(target);
    const id = target.dataset.nodeId;
    const move = (el: HTMLElement | undefined) => {
      if (!el) return;
      el.tabIndex = 0;
      target.tabIndex = -1;
      el.focus();
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(items[index + 1]);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(items[index - 1]);
        break;
      case "Home":
        e.preventDefault();
        move(items[0]);
        break;
      case "End":
        e.preventDefault();
        move(items[items.length - 1]);
        break;
      case "ArrowRight": {
        e.preventDefault();
        if (target.getAttribute("aria-expanded") === "false" && id) {
          this.collapsed.delete(id);
          this.rebuild();
          this.focusItem(id);
        } else if (target.getAttribute("aria-expanded") === "true") {
          move(target.querySelector<HTMLElement>("[role='treeitem']") ?? undefined);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (target.getAttribute("aria-expanded") === "true" && id) {
          this.collapsed.add(id);
          this.rebuild();
          this.focusItem(id);
        } else {
          const parent = target.parentElement?.closest<HTMLElement>("[role='treeitem']");
          move(parent ?? undefined);
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (!id || id.startsWith("$")) break;
        const node = this.store.getNode(id.split("#")[0]!);
        if (node && (node.type === "sticky" || node.type === "shape" || node.type === "text" || node.type === "frame")) {
          this.pendingRefocus = id;
          this.hooks.openEditor(node);
        }
        break;
      }
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        if (!id || id.startsWith("$") || id.includes("#")) break;
        const next = items[index + 1] ?? items[index - 1];
        if (this.store.getNode(id)) this.store.deleteNode(id);
        else if (this.store.getConnector(id)) this.store.deleteConnector(id);
        this.editor.clearSelection();
        this.focusedId = next?.dataset.nodeId ?? null;
        this.hooks.onChange();
        break;
      }
    }
  }

  private jumpTo(n: { x: number; y: number; w: number; h: number }): void {
    const vw = window.innerWidth / this.camera.zoom;
    const vh = window.innerHeight / this.camera.zoom;
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    const visible =
      cx > this.camera.x && cx < this.camera.x + vw &&
      cy > this.camera.y && cy < this.camera.y + vh;
    if (!visible) {
      this.camera.x = cx - vw / 2;
      this.camera.y = cy - vh / 2;
    }
  }
}
