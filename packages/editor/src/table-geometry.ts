import type { TableNode } from "@orim/schema";
import type { Point, Rect } from "./camera";

export const TABLE_ROW_H = 34;

/** Column x-offsets (within the node) plus total: weights scaled to fit n.w. */
export function tableColumnEdges(table: TableNode): number[] {
  const totalWeight = table.columns.reduce((s, c) => s + c.w, 0) || 1;
  const edges = [0];
  let acc = 0;
  for (const c of table.columns) {
    acc += (c.w / totalWeight) * table.w;
    edges.push(acc);
  }
  return edges;
}

/** Rect of a cell; rowIndex -1 is the header row. */
export function tableCellRect(table: TableNode, rowIndex: number, colIndex: number): Rect {
  const edges = tableColumnEdges(table);
  const x = table.x + edges[colIndex]!;
  const w = edges[colIndex + 1]! - edges[colIndex]!;
  return { x, y: table.y + (rowIndex + 1) * TABLE_ROW_H, w, h: TABLE_ROW_H };
}

/** Cell under a world point, or null. rowIndex -1 is the header row. */
export function tableCellAt(
  table: TableNode,
  p: Point,
): { rowIndex: number; colIndex: number } | null {
  const localX = p.x - table.x;
  const localY = p.y - table.y;
  if (localX < 0 || localX > table.w || localY < 0) return null;
  const rowIndex = Math.floor(localY / TABLE_ROW_H) - 1;
  if (rowIndex < -1 || rowIndex >= table.rows.length) return null;
  const edges = tableColumnEdges(table);
  for (let c = 0; c < table.columns.length; c++) {
    if (localX >= edges[c]! && localX < edges[c + 1]!) {
      return { rowIndex, colIndex: c };
    }
  }
  return null;
}

export const tableHeight = (rowCount: number): number => (rowCount + 1) * TABLE_ROW_H;
