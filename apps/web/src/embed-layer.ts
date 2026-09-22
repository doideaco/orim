/**
 * Live iframes for embed nodes, glued to the canvas through pan/zoom
 * (same trick as the text-editor overlay). Frames are inert by default —
 * pointer events fall through to the canvas so select/move/resize work —
 * and double-clicking an embed activates its iframe for scrolling and
 * clicks. Escape or clicking the canvas deactivates it again.
 */
import type { Node } from "@orim/schema";
import { toScreen, type Camera } from "@orim/editor";

interface Frame {
  wrap: HTMLDivElement;
  iframe: HTMLIFrameElement;
  url: string;
}

export class EmbedLayer {
  private frames = new Map<string, Frame>();
  private activeId: string | null = null;

  constructor(private root: HTMLElement) {}

  /** Called from the render loop every frame. */
  sync(nodes: Iterable<Node>, camera: Camera): void {
    const seen = new Set<string>();
    for (const n of nodes) {
      if (n.type !== "embed") continue;
      seen.add(n.id);
      let f = this.frames.get(n.id);
      if (!f) {
        const wrap = document.createElement("div");
        wrap.className = "orim-embed";
        const iframe = document.createElement("iframe");
        // Least privilege: no top-navigation, no downloads, no modals.
        iframe.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms allow-popups",
        );
        iframe.referrerPolicy = "no-referrer";
        iframe.loading = "lazy";
        iframe.title = `Embedded page: ${n.url}`;
        iframe.src = n.url;
        wrap.appendChild(iframe);
        this.root.appendChild(wrap);
        f = { wrap, iframe, url: n.url };
        this.frames.set(n.id, f);
      }
      if (f.url !== n.url) {
        f.url = n.url;
        f.iframe.src = n.url;
        f.iframe.title = `Embedded page: ${n.url}`;
      }
      const s = toScreen(camera, n);
      f.wrap.style.left = `${s.x}px`;
      f.wrap.style.top = `${s.y}px`;
      f.wrap.style.width = `${n.w}px`;
      f.wrap.style.height = `${n.h}px`;
      f.wrap.style.transform = `scale(${camera.zoom})`;
      f.wrap.classList.toggle("active", this.activeId === n.id);
    }
    for (const [id, f] of this.frames) {
      if (!seen.has(id)) {
        f.wrap.remove();
        this.frames.delete(id);
        if (this.activeId === id) this.activeId = null;
      }
    }
  }

  /** Make one embed interactive (or none). */
  activate(id: string | null): void {
    this.activeId = id;
  }

  get active(): string | null {
    return this.activeId;
  }
}
