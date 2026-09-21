/**
 * ProseMirror editor mounted as a DOM overlay, glued to a canvas node
 * through pan/zoom. `reposition` is called from the render loop.
 */
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import type { Node } from "@orim/schema";
import { PALETTE } from "@orim/renderer";
import { toScreen, type Camera } from "@orim/editor";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

type EditableNode = Extract<Node, { text: string }>;

export const isEditable = (n: Node): n is EditableNode =>
  n.type === "sticky" || n.type === "shape" || n.type === "text";

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
  private node: EditableNode | null = null;
  private onCommit: ((text: string) => void) | null = null;

  constructor(private root: HTMLElement) {}

  get activeId(): string | null {
    return this.node?.id ?? null;
  }

  open(node: EditableNode, camera: Camera, onCommit: (text: string) => void): void {
    this.close();
    this.node = node;
    this.onCommit = onCommit;

    const dom = document.createElement("div");
    dom.className = "orim-text-editor";
    dom.style.width = `${node.w}px`;
    dom.style.height = `${node.h}px`;
    if (node.type === "text") {
      dom.style.background = "transparent";
      dom.style.color = "#1F2430";
    } else {
      const c = PALETTE[node.color];
      dom.style.background = node.type === "shape" && node.fillStyle !== "solid" ? "#fff" : c.fill;
      dom.style.color = c.text;
    }
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
    const pm = this.view.dom as HTMLElement;
    if (node.type === "text") {
      pm.style.fontSize = `${node.fontSize}px`;
      pm.style.padding = "4px";
    }
    this.reposition(camera);
    this.view.focus();
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.atEnd(this.view.state.doc)),
    );
  }

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
