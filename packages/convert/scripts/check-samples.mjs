// Regression check: every sample file must infer the intended diagram.
// Run from packages/convert:  node --import tsx scripts/check-samples.mjs
import { readFileSync, readdirSync } from "node:fs";
import { parseDelimited, toGrid, inferPlan } from "../src/index.ts";

const SAMPLES = new URL("../../../samples/", import.meta.url).pathname;
const EXPECTED = {
  "team.csv": "hierarchy",
  "service-deps.csv": "graph",
  "sprint.csv": "kanban",
  "customers.csv": "table",
  "messy-quotes.csv": "kanban", // Priority column groups it
  "roadmap-eu.csv": "kanban", // semicolon-delimited; Quarter groups it
};

let failed = 0;
for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".csv"))) {
  const grid = toGrid(parseDelimited(readFileSync(SAMPLES + file, "utf8")));
  const plan = inferPlan(grid);
  const expected = EXPECTED[file];
  const ok = !expected || plan.kind === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "✓" : "✗"} ${file}: ${plan.kind}` +
      (expected && !ok ? ` (expected ${expected})` : "") +
      ` — ${grid.rows.length} rows, ${grid.headers.length} cols [${grid.headers.join(", ")}]`,
  );
}
process.exit(failed ? 1 : 0);
