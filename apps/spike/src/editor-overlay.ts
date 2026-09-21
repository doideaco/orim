/**
 * Spike 3: a ProseMirror editor mounted as a DOM overlay that stays glued to
 * its canvas node through pan/zoom. The overlay is positioned in screen space
 * and scaled with the camera; `reposition` is called from the render loop.
 */
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import type { StickyNode } from "@orim/schema";
import { PALETTE } from "./colors";
import { toScreen, type Camera } from "./camera";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

function docFromText(text: string) {
  const paragraphs = text.split("\n").map((line) =>
    schema.node("paragraph", null, line ? [schema.text(line)] : []),
  );
  return schema.node("doc", null, paragraphs);
}

function textFromDoc(doc: import("prosemirror-model").Node): string {
  const lines: string[] = [];
  doc.forEach((p) => lines.push(p.textContent));
  return lines.join("\n").trimEnd();
}

export class TextEditorOverlay {
  private view: EditorView | null = null;
  private dom: HTMLDivElement | null = null;
  private node: StickyNode | null = null;
  private onCommit: ((text: string) => void) | null = null;

  constructor(private root: HTMLElement) {}

  get activeId(): string | null {
    return this.node?.id ?? null;
  }

  open(node: StickyNode, camera: Camera, onCommit: (text: string) => void): void {
    this.close();
    this.node = node;
    this.onCommit = onCommit;

    const dom = document.createElement("div");
    dom.className = "orim-text-editor";
    dom.style.width = `${node.w}px`;
    dom.style.height = `${node.h}px`;
    dom.style.background = PALETTE[node.color].fill;
    dom.style.color = PALETTE[node.color].text;
    this.root.appendChild(dom);
    this.dom = dom;

    this.view = new EditorView(dom, {
      state: EditorState.create({
        doc: docFromText(node.text),
        plugins: [
          history(),
          keymap({
            "Mod-z": undo,
            "Mod-y": redo,
            "Shift-Mod-z": redo,
            Escape: () => {
              this.close();
              return true;
            },
          }),
          keymap(baseKeymap),
        ],
      }),
    });
    this.reposition(camera);
    this.view.focus();
    // Put the caret at the end, where you expect it when re-opening a note.
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.atEnd(this.view.state.doc)),
    );
  }

  /** Keep the overlay glued to the node under the current camera. */
  reposition(camera: Camera): void {
    if (!this.dom || !this.node) return;
    const s = toScreen(camera, this.node);
    this.dom.style.left = `${s.x}px`;
    this.dom.style.top = `${s.y}px`;
    this.dom.style.transform = `scale(${camera.zoom})`;
  }

  close(commit = true): void {
    if (!this.view || !this.node) return;
    const text = textFromDoc(this.view.state.doc);
    const onCommit = this.onCommit;
    this.view.destroy();
    this.dom?.remove();
    this.view = null;
    this.dom = null;
    this.node = null;
    this.onCommit = null;
    if (commit) onCommit?.(text);
  }
}
