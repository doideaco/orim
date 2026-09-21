/**
 * @orim/store — Yjs-backed board state.
 *
 * Layout: doc.getMap("nodes") maps nodeId -> Y.Map of that node's fields.
 * One Y.Map per node gives field-level last-writer-wins: two people moving
 * and recoloring the same sticky concurrently both win. Whiteboards don't
 * need more merge sophistication than that outside text runs.
 *
 * A plain-object cache mirrors the Y state incrementally, so hot readers
 * (the render loop) never touch Yjs types or rebuild the world per frame.
 */
import * as Y from "yjs";
import type { Node, NodeId } from "@orim/schema";

export const LOCAL_ORIGIN = "orim-local";

export class BoardStore {
  readonly doc: Y.Doc;
  readonly undo: Y.UndoManager;
  private readonly yNodes: Y.Map<Y.Map<unknown>>;
  private readonly cache = new Map<NodeId, Node>();
  private listeners = new Set<() => void>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yNodes = doc.getMap("nodes");
    this.undo = new Y.UndoManager(this.yNodes, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });

    this.yNodes.observeDeep((events) => {
      for (const event of events) {
        if (event.target === this.yNodes) {
          // Node added/removed at the top level.
          for (const [id, change] of event.changes.keys) {
            if (change.action === "delete") this.cache.delete(id);
            else this.refresh(id);
          }
        } else {
          // A field changed inside one node's map.
          const id = event.path[0];
          if (typeof id === "string") this.refresh(id);
        }
      }
      this.emit();
    });
  }

  private refresh(id: NodeId): void {
    const yNode = this.yNodes.get(id);
    if (yNode) this.cache.set(id, Object.fromEntries(yNode.entries()) as Node);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** Live map of all nodes. Treat as read-only; mutate via upsert/update. */
  get nodes(): ReadonlyMap<NodeId, Node> {
    return this.cache;
  }

  getNode(id: NodeId): Node | undefined {
    return this.cache.get(id);
  }

  upsertNode(node: Node): void {
    this.transact(() => {
      const yNode = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(node)) yNode.set(k, v);
      this.yNodes.set(node.id, yNode);
    });
  }

  updateNode(id: NodeId, patch: Partial<Node>): void {
    const yNode = this.yNodes.get(id);
    if (!yNode) return;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "id" || k === "type") continue;
        yNode.set(k, v);
      }
    });
  }

  deleteNode(id: NodeId): void {
    this.transact(() => this.yNodes.delete(id));
  }

  /** Batch several mutations into one undo step / one sync message. */
  transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /** Subscribe to any board change. Returns unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
