/**
 * @orim/store — Yjs-backed board state.
 *
 * Layout:
 *   doc.getMap("nodes")      nodeId -> Y.Map of that node's fields
 *   doc.getMap("connectors") connectorId -> Y.Map of that connector's fields
 *
 * One Y.Map per object gives field-level last-writer-wins: two people moving
 * and recoloring the same sticky concurrently both win. Whiteboards don't
 * need more merge sophistication than that outside text runs.
 *
 * Plain-object caches mirror the Y state incrementally, so hot readers
 * (the render loop) never touch Yjs types or rebuild the world per frame.
 * `nodesSorted` additionally maintains a z-ordered array, rebuilt lazily.
 */
import * as Y from "yjs";
import type { Connector, Node, NodeId } from "@orim/schema";

export const LOCAL_ORIGIN = "orim-local";

type Listener = () => void;

export class BoardStore {
  readonly doc: Y.Doc;
  readonly undo: Y.UndoManager;
  private readonly yNodes: Y.Map<Y.Map<unknown>>;
  private readonly yConnectors: Y.Map<Y.Map<unknown>>;
  private readonly nodeCache = new Map<NodeId, Node>();
  private readonly connectorCache = new Map<NodeId, Connector>();
  private sorted: Node[] = [];
  private sortedDirty = true;
  private listeners = new Set<Listener>();
  /** Bumped on every change; cheap cache-invalidation key for derived work. */
  revision = 0;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yNodes = doc.getMap("nodes");
    this.yConnectors = doc.getMap("connectors");
    this.undo = new Y.UndoManager([this.yNodes, this.yConnectors], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });

    const wire = (
      root: Y.Map<Y.Map<unknown>>,
      cache: Map<string, Record<string, unknown>>,
    ) => {
      root.observeDeep((events) => {
        for (const event of events) {
          if (event.target === root) {
            for (const [id, change] of event.changes.keys) {
              if (change.action === "delete") cache.delete(id);
              else this.refresh(root, cache, id);
            }
          } else {
            const id = event.path[0];
            if (typeof id === "string") this.refresh(root, cache, id);
          }
        }
        this.sortedDirty = true;
        this.revision++;
        this.emit();
      });
    };
    wire(this.yNodes, this.nodeCache as Map<string, Record<string, unknown>>);
    wire(this.yConnectors, this.connectorCache as Map<string, Record<string, unknown>>);
  }

  private refresh(
    root: Y.Map<Y.Map<unknown>>,
    cache: Map<string, Record<string, unknown>>,
    id: string,
  ): void {
    const yObj = root.get(id);
    if (yObj) cache.set(id, Object.fromEntries(yObj.entries()));
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  // --- nodes ---------------------------------------------------------------

  /** Live map of all nodes. Treat as read-only; mutate via upsert/update. */
  get nodes(): ReadonlyMap<NodeId, Node> {
    return this.nodeCache;
  }

  /** Nodes in z-order (ascending `index`; draw first-to-last). */
  get nodesSorted(): readonly Node[] {
    if (this.sortedDirty) {
      this.sorted = [...this.nodeCache.values()].sort((a, b) =>
        a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1,
      );
      this.sortedDirty = false;
    }
    return this.sorted;
  }

  getNode(id: NodeId): Node | undefined {
    return this.nodeCache.get(id);
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

  /** Deletes the node, any connectors bound to it, and re-parents children. */
  deleteNode(id: NodeId): void {
    this.transact(() => {
      this.yNodes.delete(id);
      for (const c of this.connectorCache.values()) {
        if (
          ("node" in c.from && c.from.node === id) ||
          ("node" in c.to && c.to.node === id)
        ) {
          this.yConnectors.delete(c.id);
        }
      }
      for (const n of this.nodeCache.values()) {
        if (n.parent === id) this.yNodes.get(n.id)?.set("parent", null);
      }
    });
  }

  /** Children of a frame/group (one level). */
  childrenOf(id: NodeId): Node[] {
    const out: Node[] = [];
    for (const n of this.nodeCache.values()) if (n.parent === id) out.push(n);
    return out;
  }

  /** An `index` string sorting after every existing node (bring-to-front). */
  topIndex(): string {
    let max = "";
    for (const n of this.nodeCache.values()) if (n.index > max) max = n.index;
    return max + "V"; // suffix sorts after the bare string
  }

  // --- connectors ----------------------------------------------------------

  get connectors(): ReadonlyMap<NodeId, Connector> {
    return this.connectorCache;
  }

  getConnector(id: NodeId): Connector | undefined {
    return this.connectorCache.get(id);
  }

  upsertConnector(connector: Connector): void {
    this.transact(() => {
      const yObj = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(connector)) yObj.set(k, v);
      this.yConnectors.set(connector.id, yObj);
    });
  }

  updateConnector(id: NodeId, patch: Partial<Connector>): void {
    const yObj = this.yConnectors.get(id);
    if (!yObj) return;
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "id" || k === "type") continue;
        yObj.set(k, v);
      }
    });
  }

  deleteConnector(id: NodeId): void {
    this.transact(() => this.yConnectors.delete(id));
  }

  // --- shared --------------------------------------------------------------

  /** Batch several mutations into one undo step / one sync message. */
  transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /** Subscribe to any board change. Returns unsubscribe. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
