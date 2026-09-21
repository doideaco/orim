/**
 * Comment threads: a floating panel next to the pin with the thread,
 * a reply box, resolve and delete. Pins live on the canvas (renderer);
 * this module owns the popover and pin hit-testing.
 */
import type { BoardComment } from "@orim/schema";
import { toScreen, type Camera } from "@orim/editor";
import { commentPinPos } from "@orim/renderer";
import type { BoardStore } from "@orim/store";

const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const timeAgo = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export class CommentsUI {
  activeId: string | null = null;
  private panel: HTMLElement;
  private pendingAnchor: BoardComment["anchor"] | null = null;
  /** The click that opens the panel also bubbles to window; skip it. */
  private suppressClose = false;

  constructor(
    private store: BoardStore,
    private camera: Camera,
    private author: () => string,
    private onChange: () => void,
  ) {
    this.panel = document.getElementById("comment-panel")!;
    window.addEventListener("pointerdown", (e) => {
      if (this.suppressClose) {
        this.suppressClose = false;
        return;
      }
      if (this.activeId === null && !this.pendingAnchor) return;
      const t = e.target as HTMLElement;
      if (this.panel.contains(t)) return;
      // A click on another pin switches threads; the canvas handler owns it.
      if (this.pinAt({ x: e.clientX, y: e.clientY })) return;
      this.close();
    });
  }

  /** Unresolved comments, for pins and hit-testing. */
  visible(): BoardComment[] {
    return [...this.store.comments.values()].filter((c) => !c.resolved);
  }

  pinAt(screen: { x: number; y: number }): BoardComment | null {
    for (const c of this.visible()) {
      const world = commentPinPos(c, (id) => this.store.getNode(id));
      if (!world) continue;
      const s = toScreen(this.camera, world);
      if (Math.hypot(s.x - screen.x, s.y - screen.y + 3) <= 14) return c;
    }
    return null;
  }

  compose(anchor: BoardComment["anchor"]): void {
    this.pendingAnchor = anchor;
    this.activeId = null;
    this.suppressClose = true;
    this.render();
  }

  open(id: string): void {
    this.activeId = id;
    this.pendingAnchor = null;
    this.suppressClose = true;
    this.render();
  }

  close(): void {
    this.activeId = null;
    this.pendingAnchor = null;
    this.panel.classList.remove("open");
    this.onChange();
  }

  /** Keep the panel glued next to its pin; called from the render loop. */
  reposition(): void {
    if (!this.panel.classList.contains("open")) return;
    const anchor =
      this.pendingAnchor ??
      (this.activeId ? this.store.getComment(this.activeId)?.anchor : null);
    if (!anchor) return;
    const world =
      "point" in anchor
        ? anchor.point
        : (() => {
            const n = this.store.getNode(anchor.node);
            return n ? { x: n.x + n.w, y: n.y } : null;
          })();
    if (!world) return;
    const s = toScreen(this.camera, world);
    const w = 280;
    const x = Math.min(Math.max(12, s.x + 18), window.innerWidth - w - 12);
    const y = Math.min(Math.max(12, s.y - 10), window.innerHeight - 200);
    this.panel.style.left = `${x}px`;
    this.panel.style.top = `${y}px`;
  }

  /** Re-render the open thread (e.g. when a reply arrives over sync). */
  refresh(): void {
    if (this.activeId && !this.store.getComment(this.activeId)) {
      this.close();
      return;
    }
    if (this.panel.classList.contains("open")) this.render();
  }

  private render(): void {
    this.panel.replaceChildren();
    this.panel.classList.add("open");
    const comment = this.activeId ? this.store.getComment(this.activeId) : null;

    if (comment) {
      const thread = document.createElement("div");
      thread.className = "thread";
      const messages = [
        { author: comment.author, body: comment.body, at: comment.at },
        ...comment.replies,
      ];
      for (const m of messages) {
        const msg = document.createElement("div");
        msg.className = "msg";
        const head = document.createElement("div");
        head.className = "msg-head";
        head.textContent = `${m.author} · ${timeAgo(m.at)}`;
        const body = document.createElement("div");
        body.className = "msg-body";
        body.textContent = m.body;
        msg.append(head, body);
        thread.appendChild(msg);
      }
      this.panel.appendChild(thread);
    }

    const box = document.createElement("textarea");
    box.placeholder = comment ? "Reply…" : "Add a comment…";
    box.rows = 2;
    this.panel.appendChild(box);

    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = document.createElement("button");
    submit.className = "primary";
    submit.textContent = comment ? "Reply" : "Comment";
    submit.addEventListener("click", () => this.submit(box.value));
    actions.appendChild(submit);

    if (comment) {
      const resolve = document.createElement("button");
      resolve.textContent = "Resolve";
      resolve.addEventListener("click", () => {
        this.store.updateComment(comment.id, { resolved: true });
        this.close();
      });
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        this.store.deleteComment(comment.id);
        this.close();
      });
      actions.append(resolve, del);
    }
    this.panel.appendChild(actions);

    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit(box.value);
      }
      if (e.key === "Escape") this.close();
    });
    this.reposition();
    box.focus();
  }

  private submit(body: string): void {
    const text = body.trim();
    if (!text) return;
    if (this.activeId) {
      const c = this.store.getComment(this.activeId);
      if (c) {
        this.store.updateComment(c.id, {
          replies: [...c.replies, { author: this.author(), body: text, at: Date.now() }],
        });
        this.render();
      }
    } else if (this.pendingAnchor) {
      const id = rid();
      this.store.upsertComment({
        id,
        anchor: this.pendingAnchor,
        author: this.author(),
        body: text,
        at: Date.now(),
        resolved: false,
        replies: [],
      });
      this.pendingAnchor = null;
      this.activeId = id;
      this.render();
    }
    this.onChange();
  }
}
