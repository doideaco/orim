/**
 * The Data panel: the structured graph behind the drawing, as a live,
 * navigable outline (reading order — the same order exports and the future
 * accessibility tree use) plus an inspector for the selected object,
 * including its free-form `data` bag. Click a row to select and jump to it.
 */
import type { Connector, Node } from "@orim/schema";
import { orderBoard, nodeLabel, type ExportBoard } from "@orim/convert";
import { PALETTE } from "@orim/renderer";
import type { BoardStore } from "@orim/store";
import type { Camera, Editor } from "@orim/editor";

export class DataPanel {
  private panel = document.getElementById("datapanel")!;
  private outline = document.getElementById("outline")!;
  private inspector = document.getElementById("inspector")!;
  private button = document.getElementById("btn-data")!;
  private scheduled = false;

  constructor(
    private store: BoardStore,
    private editor: Editor,
    private camera: Camera,
    private onChange: () => void,
  ) {
    this.button.addEventListener("click", () => this.toggle());
  }

  get isOpen(): boolean {
    return this.panel.classList.contains("open");
  }

  toggle(open = !this.isOpen): void {
    this.panel.classList.toggle("open", open);
    this.button.classList.toggle("active", open);
    document.body.classList.toggle("datapanel-open", open);
    if (open) this.refresh();
  }

  /** Coalesce refreshes into one per frame. */
  scheduleRefresh(): void {
    if (!this.isOpen || this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      if (this.isOpen) this.refresh();
    });
  }

  refresh(): void {
    const board: ExportBoard = {
      nodes: [...this.store.nodes.values()],
      connectors: [...this.store.connectors.values()],
    };
    const ordered = orderBoard(board);
    this.outline.replaceChildren();

    for (const { frame, children } of ordered.frames) {
      this.outline.appendChild(this.nodeRow(frame, "frame-row"));
      for (const child of children) this.outline.appendChild(this.nodeRow(child, "child"));
    }
    if (ordered.loose.length && ordered.frames.length) {
      this.outline.appendChild(this.heading("Elsewhere"));
    }
    for (const n of ordered.loose) this.outline.appendChild(this.nodeRow(n, ""));

    if (board.connectors.length) {
      this.outline.appendChild(this.heading("Connections"));
      const byId = new Map(board.nodes.map((n) => [n.id, n]));
      for (const c of board.connectors) {
        this.outline.appendChild(this.connectorRow(c, byId));
      }
    }

    this.renderInspector();
  }

  private heading(label: string): HTMLElement {
    const h = document.createElement("h2");
    h.textContent = label;
    return h;
  }

  private nodeRow(n: Node, extraClass: string): HTMLElement {
    const row = document.createElement("button");
    row.className = `row ${extraClass}`;
    row.classList.toggle("selected", this.editor.selection.has(n.id));

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background =
      n.type === "frame" ? "#fff" :
      n.type === "text" ? "transparent" :
      PALETTE[n.type === "sticky" || n.type === "shape" || n.type === "ink" ? n.color : "gray"].fill;
    row.appendChild(dot);

    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = nodeLabel(n).replace(/\n/g, " ");
    row.appendChild(lbl);

    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = n.type === "shape" ? n.kind : n.type;
    row.appendChild(kind);

    row.addEventListener("click", () => {
      this.editor.selectOnly(n.id);
      this.jumpTo(n);
      this.onChange();
      this.refresh();
    });
    return row;
  }

  private connectorRow(c: Connector, byId: Map<string, Node>): HTMLElement {
    const row = document.createElement("button");
    row.className = "row conn";
    row.classList.toggle("selected", this.editor.connectorSelection.has(c.id));
    const end = (e: Connector["from"]): string =>
      "point" in e ? "(point)" : nodeLabel(byId.get(e.node)!).replace(/\n/g, " ").slice(0, 20);
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = `${end(c.from)} → ${end(c.to)}${c.label ? ` · ${c.label}` : ""}`;
    row.appendChild(lbl);
    row.addEventListener("click", () => {
      this.editor.clearSelection();
      this.editor.connectorSelection.add(c.id);
      this.onChange();
      this.refresh();
    });
    return row;
  }

  private jumpTo(n: Node): void {
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

  private renderInspector(): void {
    const node = this.editor.singleSelectedNode();
    if (!node) {
      this.inspector.innerHTML = `<div class="empty">Select an object to inspect it.</div>`;
      return;
    }
    this.inspector.replaceChildren();

    const dl = document.createElement("dl");
    const field = (k: string, v: string) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    };
    field("id", node.id);
    field("type", node.type === "shape" ? `shape · ${node.kind}` : node.type);
    field("position", `${Math.round(node.x)}, ${Math.round(node.y)}`);
    field("size", `${Math.round(node.w)} × ${Math.round(node.h)}`);
    if ("color" in node) field("color", node.color);
    if (node.parent) {
      const p = this.store.getNode(node.parent);
      field("parent", p ? nodeLabel(p) : node.parent);
    }
    if ("author" in node && node.author) field("author", node.author);
    if ("text" in node && node.text) {
      field("text", node.text.replace(/\n/g, " ").slice(0, 80));
    }
    this.inspector.appendChild(dl);

    const label = document.createElement("label");
    label.textContent = "data (JSON) — typed fields on this object";
    this.inspector.appendChild(label);
    const textarea = document.createElement("textarea");
    textarea.value = JSON.stringify(node.data ?? {}, null, 2);
    textarea.spellcheck = false;
    this.inspector.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "actions";
    const apply = document.createElement("button");
    apply.textContent = "Apply";
    const err = document.createElement("span");
    err.className = "err";
    actions.append(apply, err);
    this.inspector.appendChild(actions);

    apply.addEventListener("click", () => {
      try {
        const parsed: unknown = JSON.parse(textarea.value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("must be a JSON object");
        }
        this.store.updateNode(node.id, { data: parsed as Record<string, unknown> });
        err.textContent = "";
        this.onChange();
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }
}
