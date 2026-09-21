/**
 * Board → Mermaid flowchart. Nodes that participate in connectors are
 * emitted with shape-appropriate Mermaid brackets; connected structure
 * survives the trip into any Markdown file or docs site.
 */
import type { Endpoint, Node } from "@orim/schema";
import { nodeLabel, type ExportBoard } from "./order";

const esc = (s: string): string =>
  s.replace(/\n/g, " ").replace(/"/g, "'").slice(0, 80) || " ";

function mermaidNode(id: string, n: Node): string {
  const label = `"${esc(nodeLabel(n))}"`;
  if (n.type === "shape") {
    switch (n.kind) {
      case "ellipse": return `${id}((${label}))`;
      case "diamond": return `${id}{${label}}`;
      case "pill": return `${id}(${label})`;
      default: return `${id}[${label}]`;
    }
  }
  return `${id}[${label}]`;
}

export function boardToMermaid(board: ExportBoard): string {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const mermaidIds = new Map<string, string>();
  const declared: string[] = [];
  const edges: string[] = [];

  const idFor = (nodeId: string): string | null => {
    const n = byId.get(nodeId);
    if (!n) return null;
    let mid = mermaidIds.get(nodeId);
    if (!mid) {
      mid = `n${mermaidIds.size + 1}`;
      mermaidIds.set(nodeId, mid);
      declared.push(`  ${mermaidNode(mid, n)}`);
    }
    return mid;
  };

  for (const c of board.connectors) {
    const end = (e: Endpoint): string | null => ("point" in e ? null : idFor(e.node));
    const from = end(c.from);
    const to = end(c.to);
    if (!from || !to) continue;
    const arrow = c.style === "line" ? "---" : c.style === "double" ? "<-->" : "-->";
    const label = c.label ? `|${esc(c.label)}|` : "";
    edges.push(`  ${from} ${arrow}${label} ${to}`);
  }

  return ["flowchart TD", ...declared, ...edges].join("\n") + "\n";
}
