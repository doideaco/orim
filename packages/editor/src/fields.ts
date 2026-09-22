/**
 * Smart fields: numeric entries in a node's `data` bag become visible
 * chips, and frames aggregate their children's fields with zero config —
 * put numbers on stickies inside a frame and the frame starts computing.
 *
 * Chip geometry lives here (not the renderer) so drawing and hit-testing
 * share one layout. Widths are estimated (fields also render in Node,
 * where there's no canvas to measure with).
 */
import type { FrameNode, Node } from "@orim/schema";
import type { Rect } from "./camera";

export const CHIP_H = 18;
export const AGG_CHIP_H = 20;
const CHAR_W = 6.1; // estimated px per character at chip font size

export type AggOp = "sum" | "avg" | "min" | "max" | "count";
export const AGG_OPS: AggOp[] = ["sum", "avg", "min", "max", "count"];
export const AGG_SYMBOL: Record<AggOp, string> = {
  sum: "Σ", avg: "avg", min: "min", max: "max", count: "#",
};

/** Numeric, non-internal fields ($-prefixed keys are machinery). */
export function numericFields(n: Node): [string, number][] {
  return Object.entries(n.data ?? {}).filter(
    (e): e is [string, number] =>
      !e[0].startsWith("$") && typeof e[1] === "number" && Number.isFinite(e[1]),
  );
}

export const formatFieldValue = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);

export interface FieldChip {
  key: string;
  value: number;
  label: string;
  rect: Rect;
}

/** Chips along the bottom edge of a sticky or shape. */
export function fieldChips(n: Node): FieldChip[] {
  if (n.type !== "sticky" && n.type !== "shape") return [];
  const chips: FieldChip[] = [];
  let x = n.x + 8;
  const y = n.y + n.h - CHIP_H - 7;
  for (const [key, value] of numericFields(n).slice(0, 4)) {
    const label = `${key} ${formatFieldValue(value)}`;
    const w = label.length * CHAR_W + 12;
    if (x + w > n.x + n.w - 6) break;
    chips.push({ key, value, label, rect: { x, y, w, h: CHIP_H } });
    x += w + 5;
  }
  return chips;
}

export interface FrameAggregate {
  field: string;
  op: AggOp;
  value: number;
  label: string;
  rect: Rect;
}

function compute(op: AggOp, values: number[]): number {
  switch (op) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    case "count": return values.length;
  }
}

/**
 * Zero-config aggregates: any numeric field carried by 2+ children gets a
 * chip in the frame's title strip. The op per field is stored on the
 * frame at data.$agg and cycled by clicking the chip.
 */
export function frameAggregates(frame: FrameNode, children: Node[]): FrameAggregate[] {
  const byField = new Map<string, number[]>();
  for (const child of children) {
    for (const [key, value] of numericFields(child)) {
      let list = byField.get(key);
      if (!list) {
        list = [];
        byField.set(key, list);
      }
      list.push(value);
    }
  }
  const prefs = ((frame.data as { $agg?: Record<string, AggOp> })?.$agg) ?? {};
  const aggs: FrameAggregate[] = [];
  for (const [field, values] of [...byField.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (values.length < 2) continue;
    const op = AGG_OPS.includes(prefs[field]!) ? prefs[field]! : "sum";
    const value = compute(op, values);
    aggs.push({
      field, op, value,
      label: `${field} ${AGG_SYMBOL[op]} ${formatFieldValue(value)}`,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    });
  }
  // Lay out right-aligned in the title strip above the frame.
  let right = frame.x + frame.w;
  for (let i = aggs.length - 1; i >= 0; i--) {
    const agg = aggs[i]!;
    const w = agg.label.length * CHAR_W + 14;
    agg.rect = { x: right - w, y: frame.y - AGG_CHIP_H - 6, w, h: AGG_CHIP_H };
    right -= w + 6;
  }
  return aggs;
}

export const nextAggOp = (op: AggOp): AggOp =>
  AGG_OPS[(AGG_OPS.indexOf(op) + 1) % AGG_OPS.length]!;

/** Numeric column totals for a table (2+ numeric cells). */
export function tableColumnTotals(
  table: Extract<Node, { type: "table" }>,
): { colIndex: number; sum: number; count: number }[] {
  return table.columns
    .map((col, colIndex) => {
      const values = table.rows
        .map((r) => r.cells[col.id])
        .filter((v): v is string => v !== undefined && v.trim() !== "")
        .map(Number)
        .filter((v) => Number.isFinite(v));
      return { colIndex, sum: values.reduce((a, b) => a + b, 0), count: values.length };
    })
    .filter((t) => t.count >= 2);
}
