/**
 * The Data panel: the structured graph behind the drawing, as a live,
 * navigable outline (reading order — the same order exports and the future
 * accessibility tree use) plus an inspector for the selected object,
 * including its free-form `data` bag. Click a row to select and jump to it.
 */
import {
  cellSource, type Connector, type FrameNode, type Node, type StickyNode,
} from "@orim/schema";
import { findEmptySpace, synthesizeTable } from "@orim/layout";
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

    // Board settings row: currency for cost-shaped fields (synced meta).
    const settings = document.createElement("div");
    settings.className = "panel-settings";
    const label = document.createElement("span");
    label.textContent = "Currency";
    const select = document.createElement("select");
    for (const [value, text] of [["", "auto"], ["$", "$"], ["£", "£"], ["€", "€"], ["kr", "kr"], ["¥", "¥"], ["none", "none"]]) {
      const opt = document.createElement("option");
      opt.value = value!;
      opt.textContent = text!;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.store.setMeta(
        "currency",
        select.value === "" ? undefined : select.value === "none" ? "" : select.value,
      );
      this.onChange();
    });
    this.currencySelect = select;
    settings.append(label, select);
    this.outline.before(settings);
  }

  private currencySelect!: HTMLSelectElement;

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
    const meta = this.store.getMeta<string>("currency");
    this.currencySelect.value = meta === undefined ? "" : meta === "" ? "none" : meta;
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

  /** Multi-selection: counts + cluster synthesis. */
  private renderMultiInspector(): void {
    this.inspector.replaceChildren();
    const selected = [...this.editor.selection]
      .map((id) => this.store.getNode(id))
      .filter((n): n is Node => !!n);
    const summary = document.createElement("div");
    summary.className = "empty";
    summary.textContent = `${selected.length} objects selected`;
    this.inspector.appendChild(summary);

    const stickies = selected.filter(
      (n): n is StickyNode => n.type === "sticky" && !cellSource(n),
    );
    if (stickies.length < 2) return;

    const actions = document.createElement("div");
    actions.className = "actions";
    const b = document.createElement("button");
    b.textContent = `Stickies → table (${stickies.length})`;
    b.addEventListener("click", () => {
      this.synthesize(stickies);
      this.onChange();
      this.scheduleRefresh();
    });
    actions.appendChild(b);
    this.inspector.appendChild(actions);
  }

  /** Spatial clusters of the given stickies become a table; each sticky
   *  becomes a live view of its row. */
  private synthesize(stickies: StickyNode[]): void {
    const frames = [...this.store.nodes.values()].filter(
      (n): n is FrameNode => n.type === "frame",
    );
    const { columns, rows, bindings } = synthesizeTable(stickies, frames);
    if (!rows.length) return;

    const w = columns.reduce((s, c) => s + c.w, 0);
    const h = (rows.length + 1) * 34;
    const right = Math.max(...stickies.map((s) => s.x + s.w));
    const top = Math.min(...stickies.map((s) => s.y));
    const pos = findEmptySpace(
      [...this.store.nodes.values()],
      w, h,
      { x: right + 120, y: top },
    );

    const tableId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.store.transact(() => {
      this.store.upsertNode({
        id: tableId,
        type: "table",
        parent: null,
        x: pos.x, y: pos.y, w, h,
        rotation: 0,
        index: this.store.topIndex(),
        locked: false,
        data: {},
        title: "Synthesis",
        columns,
        rows,
      });
      for (const b of bindings) {
        const sticky = this.store.getNode(b.stickyId);
        if (!sticky) continue;
        this.store.updateNode(b.stickyId, {
          data: { ...sticky.data, $source: { table: tableId, row: b.rowId, column: b.columnId } },
        });
      }
    });
    this.editor.selectOnly(tableId);
    const table = this.store.getNode(tableId);
    if (table) this.jumpTo(table);
  }

  private renderTableActions(table: Extract<Node, { type: "table" }>): void {
    const actions = document.createElement("div");
    actions.className = "actions";
    const btn = (label: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        onClick();
        this.onChange();
        this.scheduleRefresh();
      });
      actions.appendChild(b);
    };
    const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    btn("+ Row", () => {
      const live = this.store.getNode(table.id);
      if (live?.type !== "table") return;
      this.store.updateNode(table.id, {
        rows: [...live.rows, { id: rid(), cells: {} }],
        h: Math.max(live.h, (live.rows.length + 2) * 34),
      });
    });
    btn("+ Column", () => {
      const live = this.store.getNode(table.id);
      if (live?.type !== "table") return;
      this.store.updateNode(table.id, {
        columns: [...live.columns, { id: rid(), name: `Column ${live.columns.length + 1}`, w: 160 }],
        w: live.w + 160,
      });
    });
    btn("Rows → stickies", () => {
      const live = this.store.getNode(table.id);
      if (live?.type !== "table" || !live.rows.length) return;
      const column = live.columns[0]?.id;
      if (!column) return;
      const bound = new Set(
        [...this.store.nodes.values()]
          .map((n) => cellSource(n))
          .filter((s) => s?.table === live.id)
          .map((s) => s!.row),
      );
      this.editor.clearSelection();
      this.store.transact(() => {
        let placed = 0;
        for (const row of live.rows) {
          if (bound.has(row.id)) continue; // already materialized somewhere
          // A bound sticky: text derives from the cell (the cell is the
          // source of truth) and its position is entirely its own.
          const sticky: Node = {
            id: rid(),
            type: "sticky",
            parent: null,
            x: live.x + live.w + 80,
            y: live.y + placed * 144,
            w: 180, h: 120,
            rotation: 0,
            index: this.store.topIndex(),
            locked: false,
            data: { $source: { table: live.id, row: row.id, column } },
            text: row.cells[column] ?? "",
            color: "yellow",
          };
          this.store.upsertNode(sticky);
          this.editor.selection.add(sticky.id);
          placed++;
        }
      });
    });
    this.inspector.appendChild(actions);
  }

  private renderInspector(): void {
    const node = this.editor.singleSelectedNode();
    if (!node) {
      if (this.editor.selection.size > 1) {
        this.renderMultiInspector();
      } else {
        this.inspector.innerHTML = `<div class="empty">Select an object to inspect it.</div>`;
      }
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
    const src = cellSource(node);
    if (src) {
      const t = this.store.getNode(src.table);
      const colName =
        t?.type === "table" ? t.columns.find((c) => c.id === src.column)?.name : undefined;
      field("bound to", `${t ? nodeLabel(t) : src.table} · ${colName ?? src.column}`);
    }
    if ("text" in node && node.text) {
      field("text", node.text.replace(/\n/g, " ").slice(0, 80));
    }
    if (node.type === "table") {
      field("columns", String(node.columns.length));
      field("rows", String(node.rows.length));
    }
    this.inspector.appendChild(dl);

    if (node.type === "table") this.renderTableActions(node);

    this.renderFieldRows(node);
  }

  /** Structured editor for the data bag: one row per field, add/remove,
   *  numbers parsed as numbers. Raw JSON stays behind an advanced toggle. */
  private renderFieldRows(node: Node): void {
    const label = document.createElement("label");
    label.textContent = "fields — typed data on this object";
    this.inspector.appendChild(label);

    const setField = (key: string, raw: string) => {
      const live = this.store.getNode(node.id);
      if (!live) return;
      const data = { ...live.data } as Record<string, unknown>;
      const trimmed = raw.trim();
      const num = Number(trimmed);
      if (trimmed === "") delete data[key];
      else data[key] = Number.isFinite(num) ? num : trimmed;
      this.store.updateNode(node.id, { data });
      this.onChange();
      this.scheduleRefresh();
    };

    const rows = document.createElement("div");
    rows.className = "field-rows";
    const entries = Object.entries(node.data ?? {}).filter(([k]) => !k.startsWith("$"));
    for (const [key, value] of entries) {
      const row = document.createElement("div");
      row.className = "field-row";
      const name = document.createElement("span");
      name.textContent = key;
      const input = document.createElement("input");
      input.value = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
      });
      input.addEventListener("blur", () => setField(key, input.value));
      const del = document.createElement("button");
      del.textContent = "✕";
      del.setAttribute("aria-label", `Remove field ${key}`);
      del.addEventListener("click", () => setField(key, ""));
      row.append(name, input, del);
      rows.appendChild(row);
    }
    this.inspector.appendChild(rows);

    const addRow = document.createElement("div");
    addRow.className = "field-row add";
    const keyInput = document.createElement("input");
    keyInput.placeholder = "field";
    const valInput = document.createElement("input");
    valInput.placeholder = "value";
    const add = () => {
      const key = keyInput.value.trim();
      if (!key || key.startsWith("$")) return;
      setField(key, valInput.value);
    };
    for (const input of [keyInput, valInput]) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") add();
      });
    }
    const addBtn = document.createElement("button");
    addBtn.textContent = "+";
    addBtn.setAttribute("aria-label", "Add field");
    addBtn.addEventListener("click", add);
    addRow.append(keyInput, valInput, addBtn);
    this.inspector.appendChild(addRow);

    const advanced = document.createElement("button");
    advanced.className = "linkish";
    advanced.textContent = "Edit as JSON";
    this.inspector.appendChild(advanced);
    advanced.addEventListener("click", () => {
      advanced.remove();
      const textarea = document.createElement("textarea");
      textarea.value = JSON.stringify(node.data ?? {}, null, 2);
      textarea.spellcheck = false;
      const actions = document.createElement("div");
      actions.className = "actions";
      const apply = document.createElement("button");
      apply.textContent = "Apply";
      const err = document.createElement("span");
      err.className = "err";
      actions.append(apply, err);
      this.inspector.append(textarea, actions);
      textarea.addEventListener("keydown", (e) => e.stopPropagation());
      apply.addEventListener("click", () => {
        try {
          const parsed: unknown = JSON.parse(textarea.value);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("must be a JSON object");
          }
          this.store.updateNode(node.id, { data: parsed as Record<string, unknown> });
          err.textContent = "";
          this.onChange();
          this.scheduleRefresh();
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : String(e);
        }
      });
    });
  }
}
