/**
 * Board → Markdown outline. A retro board should export as a readable
 * document, not a screenshot: frames become sections, content becomes
 * bullets in reading order, connections become an explicit list.
 */
import type { Connector, Endpoint, Node } from "@orim/schema";
import { orderBoard, nodeLabel, type ExportBoard } from "./order";

function bullet(n: Node): string {
  const label = nodeLabel(n).replace(/\n/g, " — ");
  return `- ${label}`;
}

/** Tables export as real Markdown tables; everything else as a bullet. */
function nodeBlock(n: Node): string[] {
  if (n.type !== "table") return [bullet(n)];
  const cell = (s: string) => s.replace(/\n/g, " ").replace(/\|/g, "\\|") || " ";
  return [
    `**${n.title}**`,
    "",
    `| ${n.columns.map((c) => cell(c.name)).join(" | ")} |`,
    `| ${n.columns.map(() => "---").join(" | ")} |`,
    ...n.rows.map((r) => `| ${n.columns.map((c) => cell(r.cells[c.id] ?? "")).join(" | ")} |`),
    "",
  ];
}

export function boardToMarkdown(board: ExportBoard): string {
  const ordered = orderBoard(board);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const lines: string[] = [`# ${board.title ?? "Untitled board"}`, ""];

  const withVotes = (n: Node, block: string[]): string[] => {
    const votes = board.votes?.[n.id];
    if (!votes || !block[0]?.startsWith("- ")) return block;
    return [`${block[0]} — ${votes} vote${votes === 1 ? "" : "s"}`, ...block.slice(1)];
  };

  for (const { frame, children } of ordered.frames) {
    lines.push(`## ${frame.title}`, "");
    for (const child of children) lines.push(...withVotes(child, nodeBlock(child)));
    if (children.length) lines.push("");
  }

  if (ordered.loose.length) {
    if (ordered.frames.length) lines.push(`## Elsewhere on the board`, "");
    for (const n of ordered.loose) lines.push(...withVotes(n, nodeBlock(n)));
    lines.push("");
  }

  if (board.connectors.length) {
    lines.push(`## Connections`, "");
    const endLabel = (e: Endpoint): string => {
      if ("point" in e) return "(point)";
      const n = byId.get(e.node);
      if (!n) return "(missing)";
      if (e.row && n.type === "table") {
        const row = n.rows.find((r) => r.id === e.row);
        const first = row ? Object.values(row.cells).find(Boolean) : undefined;
        if (first) return `${nodeLabel(n)} row "${first}"`.replace(/\n/g, " ");
      }
      return nodeLabel(n).replace(/\n/g, " ");
    };
    for (const c of board.connectors) {
      const arrow = c.style === "double" ? "↔" : "→";
      const label = c.label ? ` (${c.label})` : "";
      lines.push(`- ${endLabel(c.from)} ${arrow} ${endLabel(c.to)}${label}`);
    }
    lines.push("");
  }

  const open = (board.comments ?? []).filter((c) => !c.resolved);
  if (open.length) {
    lines.push(`## Comments`, "");
    for (const c of open) {
      const anchor =
        "node" in c.anchor
          ? (() => {
              const n = byId.get(c.anchor.node as string);
              return n ? ` on "${nodeLabel(n).replace(/\n/g, " ")}"` : "";
            })()
          : "";
      lines.push(`- **${c.author}**${anchor}: ${c.body.replace(/\n/g, " ")}`);
      for (const r of c.replies) {
        lines.push(`  - ${r.author}: ${r.body.replace(/\n/g, " ")}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
