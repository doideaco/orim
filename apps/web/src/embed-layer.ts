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
  chrome: HTMLDivElement;
  url: string;
}

/** Corner handles + side ports, mirroring the canvas selection chrome
 *  (which an iframe would otherwise cover). Positions in percent so the
 *  wrap's scale transform places them; sizes are set per-frame in
 *  screen pixels compensated for zoom. */
const CHROME_SPOTS: { left: string; top: string; port: boolean }[] = [
  { left: "0%", top: "0%", port: false },
  { left: "100%", top: "0%", port: false },
  { left: "0%", top: "100%", port: false },
  { left: "100%", top: "100%", port: false },
  { left: "50%", top: "0%", port: true },
  { left: "50%", top: "100%", port: true },
  { left: "0%", top: "50%", port: true },
  { left: "100%", top: "50%", port: true },
];

export class EmbedLayer {
  private frames = new Map<string, Frame>();
  private activeId: string | null = null;

  constructor(private root: HTMLElement) {}

  /** Called from the render loop every frame. */
  sync(nodes: Iterable<Node>, camera: Camera, selection?: ReadonlySet<string>): void {
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
        const chrome = document.createElement("div");
        chrome.className = "embed-chrome";
        for (const spot of CHROME_SPOTS) {
          const dot = document.createElement("i");
          if (spot.port) dot.className = "port";
          dot.style.left = spot.left;
          dot.style.top = spot.top;
          chrome.appendChild(dot);
        }
        wrap.appendChild(chrome);
        this.root.appendChild(wrap);
        f = { wrap, iframe, chrome, url: n.url };
        this.frames.set(n.id, f);
      }
      if (f.url !== n.url) {
        f.url = n.url;
        f.iframe.src = n.url;
        f.iframe.title = `Embedded page: ${n.url}`;
      }
      const s = toScreen(camera, n);
      const z = camera.zoom;
      f.wrap.style.left = `${s.x}px`;
      f.wrap.style.top = `${s.y}px`;
      f.wrap.style.width = `${n.w}px`;
      f.wrap.style.height = `${n.h}px`;
      f.wrap.style.transform = `scale(${z})`;
      f.wrap.classList.toggle("active", this.activeId === n.id);
      const selected = selection?.has(n.id) ?? false;
      f.wrap.classList.toggle("selected", selected);
      if (selected) {
        // Mirror the canvas chrome in screen pixels (undo the scale).
        f.wrap.style.outline = `${2 / z}px solid #4F7CFF`;
        f.wrap.style.outlineOffset = `${2 / z}px`;
        for (const dot of f.chrome.children as HTMLCollectionOf<HTMLElement>) {
          dot.style.width = `${10 / z}px`;
          dot.style.height = `${10 / z}px`;
          dot.style.borderWidth = `${1.5 / z}px`;
        }
      } else {
        f.wrap.style.outline = "";
        f.wrap.style.outlineOffset = "";
      }
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
