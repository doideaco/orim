/**
 * Drop a CSV/TSV/Excel file on the canvas and get the right diagram:
 * org chart, dependency graph, kanban lanes, or a table — inferred from
 * the data's shape, laid out with ELK, every object carrying its source
 * row. The magic trick that makes the "canvas as database" thesis land.
 */
import type { Node } from "@orim/schema";
import {
  buildFromGrid, inferPlan, parseDelimited, toGrid, type ImportedGrid,
} from "@orim/convert";
import { cameraToFit, toWorld, type Camera, type Editor } from "@orim/editor";
import { layered } from "@orim/layout";
import type { BoardStore } from "@orim/store";

interface DropDeps {
  store: BoardStore;
  editor: Editor;
  camera: Camera;
  newId(): string;
  onDone(summary: string): void;
  onError(message: string): void;
}

async function gridFromFile(file: File): Promise<ImportedGrid | null> {
  const name = file.name.toLowerCase();
  if (/\.(xlsx|xls)$/.test(name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return null;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, {
      header: 1,
      raw: false,
      defval: "",
    }) as string[][];
    return toGrid(raw.map((r) => r.map((c) => String(c ?? ""))));
  }
  if (/\.(csv|tsv|txt)$/.test(name) || file.type.includes("csv") || file.type.startsWith("text/")) {
    return toGrid(parseDelimited(await file.text()));
  }
  return null;
}

export function setupFileDrop(deps: DropDeps): void {
  const { store, editor, camera } = deps;

  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });

  window.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    const origin = toWorld(camera, { x: e.clientX, y: e.clientY });
    void (async () => {
      try {
        const grid = await gridFromFile(file);
        if (!grid || !grid.rows.length) {
          deps.onError(`Couldn't read ${file.name} — drop a CSV, TSV or Excel file.`);
          return;
        }
        const plan = inferPlan(grid);
        const built = buildFromGrid(grid, plan, {
          newId: deps.newId,
          origin,
          index: store.topIndex(),
          title: file.name.replace(/\.[^.]+$/, ""),
        });

        if (built.layout) {
          const positions = await layered(built.nodes, built.connectors, {
            direction: built.layout,
            spacing: 40,
          });
          for (const n of built.nodes) {
            const p = positions.get(n.id);
            if (p) {
              n.x = p.x;
              n.y = p.y;
            }
          }
        }

        store.transact(() => {
          for (const n of built.nodes) store.upsertNode(n);
          for (const c of built.connectors) store.upsertConnector(c);
        });

        editor.clearSelection();
        for (const n of built.nodes) editor.selection.add(n.id);
        const bounds = boundsOf(built.nodes);
        if (bounds) {
          Object.assign(camera, cameraToFit(bounds, window.innerWidth, window.innerHeight, 96));
        }
        deps.onDone(`${file.name} → ${built.summary}`);
      } catch (err) {
        console.error("import failed", err);
        deps.onError(`Import of ${file.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    })();
  });
}

function boundsOf(nodes: Node[]) {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
