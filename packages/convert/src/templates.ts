/**
 * Board templates: small programmatic seeds for common board shapes.
 * Each template builds fresh nodes/connectors with caller-supplied ids,
 * so seeding rides the normal store pipeline (sync, undo, exports).
 */
import type { Connector, Node, PaletteColor } from "@orim/schema";

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  build(newId: () => string): { nodes: Node[]; connectors: Connector[] };
}

const base = { parent: null, rotation: 0, index: "a0", locked: false, data: {} };

const frame = (id: string, title: string, x: number, y: number, w: number, h: number): Node =>
  ({ ...base, id, type: "frame", title, x, y, w, h });

const sticky = (
  id: string, text: string, color: PaletteColor,
  x: number, y: number, parent: string | null = null,
): Node => ({ ...base, id, type: "sticky", text, color, x, y, w: 180, h: 120, parent });

const shape = (
  id: string, kind: "rect" | "ellipse" | "diamond" | "pill", text: string,
  color: PaletteColor, x: number, y: number, w = 176, h = 64,
): Node => ({ ...base, id, type: "shape", kind, text, color, fillStyle: "solid", x, y, w, h });

const arrow = (id: string, from: string, to: string, label = ""): Connector => ({
  id, type: "connector", from: { node: from, anchor: "auto" },
  to: { node: to, anchor: "auto" }, label, style: "arrow", index: "a0", data: {},
});

/** A reporting line: anchored bottom → top, which marks the diagram as a
 *  tree — Tab/Enter authoring, the "+" affordance and arrow navigation
 *  all key off this. */
const reportingLine = (id: string, parent: string, child: string): Connector => ({
  id, type: "connector", from: { node: parent, anchor: "s" },
  to: { node: child, anchor: "n" }, label: "", style: "arrow", index: "a0", data: {},
});

export const TEMPLATES: TemplateDef[] = [
  {
    id: "retro",
    name: "Retrospective",
    description: "Went well · Didn't · Actions",
    build(newId) {
      const titles: [string, PaletteColor][] = [
        ["What went well", "green"], ["What didn't", "red"], ["Actions", "violet"],
      ];
      const nodes: Node[] = [];
      titles.forEach(([title, color], i) => {
        const f = newId();
        nodes.push(frame(f, title, i * 480, 0, 440, 560));
        nodes.push(sticky(newId(), "", color, i * 480 + 24, 56, f));
      });
      return { nodes, connectors: [] };
    },
  },
  {
    id: "kanban",
    name: "Kanban",
    description: "Todo · Doing · Done lanes",
    build(newId) {
      const nodes: Node[] = ["Todo", "Doing", "Done"].map((title, i) =>
        frame(newId(), title, i * 480, 0, 440, 640),
      );
      const first = nodes[0]!.id;
      nodes.push(sticky(newId(), "Drag me across the lanes", "yellow", 24, 56, first));
      return { nodes, connectors: [] };
    },
  },
  {
    id: "flowchart",
    name: "Flowchart",
    description: "Start · decision · outcomes",
    build(newId) {
      const start = newId(), decide = newId(), yes = newId(), no = newId();
      return {
        nodes: [
          shape(start, "pill", "Start", "green", 0, 0),
          shape(decide, "diamond", "Decision?", "orange", 40, 160, 200, 110),
          shape(yes, "rect", "Do the thing", "blue", -120, 360),
          shape(no, "rect", "Do the other thing", "violet", 220, 360),
        ],
        connectors: [
          arrow(newId(), start, decide),
          arrow(newId(), decide, yes, "yes"),
          arrow(newId(), decide, no, "no"),
        ],
      };
    },
  },
  {
    id: "sprint-table",
    name: "Sprint table",
    description: "Task tracker with owners & status",
    build(newId) {
      const rows = [
        ["Define the goal", "", "Todo"],
        ["First slice end-to-end", "", "Todo"],
        ["Demo to the team", "", "Todo"],
      ];
      return {
        nodes: [{
          ...base, id: newId(), type: "table", title: "Sprint",
          x: 0, y: 0, w: 560, h: (rows.length + 1) * 34,
          columns: [
            { id: "c0", name: "Task", w: 240 },
            { id: "c1", name: "Owner", w: 140 },
            { id: "c2", name: "Status", w: 140 },
          ],
          rows: rows.map((cells, i) => ({
            id: `r${i}`,
            cells: Object.fromEntries(cells.map((v, c) => [`c${c}`, v]).filter(([, v]) => v)),
          })),
        }],
        connectors: [],
      };
    },
  },
  {
    id: "org-chart",
    name: "Org chart",
    description: "A starter reporting tree",
    build(newId) {
      const root = newId(), a = newId(), b = newId();
      return {
        nodes: [
          shape(root, "pill", "Lead", "violet", 120, 0),
          shape(a, "rect", "Report", "blue", 0, 150),
          shape(b, "rect", "Report", "blue", 240, 150),
        ],
        connectors: [reportingLine(newId(), root, a), reportingLine(newId(), root, b)],
      };
    },
  },
  {
    id: "mind-map",
    name: "Mind map",
    description: "A center topic with branches",
    build(newId) {
      const center = newId();
      const nodes: Node[] = [
        shape(center, "ellipse", "Topic", "yellow", 300, 140, 200, 90),
      ];
      const connectors: Connector[] = [];
      const branches: [string, PaletteColor, number, number][] = [
        ["Branch", "teal", 0, 0], ["Branch", "blue", 620, 0],
        ["Branch", "pink", 0, 290], ["Branch", "green", 620, 290],
      ];
      for (const [text, color, x, y] of branches) {
        const id = newId();
        nodes.push(shape(id, "rect", text, color, x, y));
        connectors.push({ ...arrow(newId(), center, id), style: "line" });
      }
      return { nodes, connectors };
    },
  },
  {
    id: "swot",
    name: "SWOT",
    description: "Strengths · Weaknesses · Opportunities · Threats",
    build(newId) {
      const quads: [string, PaletteColor, number, number][] = [
        ["Strengths", "green", 0, 0], ["Weaknesses", "red", 480, 0],
        ["Opportunities", "blue", 0, 400], ["Threats", "orange", 480, 400],
      ];
      const nodes: Node[] = [];
      for (const [title, color, x, y] of quads) {
        const f = newId();
        nodes.push(frame(f, title, x, y, 440, 360));
        nodes.push(sticky(newId(), "", color, x + 24, y + 56, f));
      }
      return { nodes, connectors: [] };
    },
  },
  {
    id: "service-blueprint",
    name: "Service blueprint",
    description: "Lanes for evidence → support",
    build(newId) {
      const lanes: [string, PaletteColor][] = [
        ["Physical evidence", "gray"], ["Customer actions", "yellow"],
        ["Frontstage", "teal"], ["Backstage", "blue"], ["Support processes", "violet"],
      ];
      const nodes: Node[] = [];
      lanes.forEach(([title, color], i) => {
        const f = newId();
        nodes.push(frame(f, title, 0, i * 260, 1400, 210));
        if (i === 1) nodes.push(sticky(newId(), "First customer step", color, 40, i * 260 + 50, f));
      });
      return { nodes, connectors: [] };
    },
  },
];
