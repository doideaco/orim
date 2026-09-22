// Pull a Miro board through Miro's REST API and write it as an Orim
// board file, ready to drop onto any Orim canvas.
//
//   export MIRO_TOKEN=...        (a Miro access token with boards:read)
//   node --import tsx scripts/import-miro.mjs <miro-board-id> [out.orim.json]
//
// Offline/testing: node --import tsx scripts/import-miro.mjs --from-file fixture.json out.json
// where the fixture is { items: [...], connectors: [...] } in Miro API shape.
import { writeFileSync, readFileSync } from "node:fs";
import { miroToBoard, boardToJSON } from "../src/index.ts";

const args = process.argv.slice(2);
const API = "https://api.miro.com/v2";

let counter = 0;
const newId = () => `miro-${(counter++).toString(36)}-${Date.now().toString(36)}`;

async function paged(url, token) {
  const out = [];
  let cursor;
  for (;;) {
    const u = new URL(url);
    u.searchParams.set("limit", "50");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${u.pathname} → ${res.status}: ${await res.text()}`);
    const body = await res.json();
    out.push(...(body.data ?? []));
    cursor = body.cursor;
    if (!cursor) break;
  }
  return out;
}

async function inlineImages(items, token) {
  // Best effort: Miro image items may carry a fetchable URL; small ones
  // are inlined as data URLs so the board stays self-contained.
  const images = new Map();
  for (const item of items) {
    if (item.type !== "image") continue;
    const url = item.data?.imageUrl ?? item.data?.url;
    if (typeof url !== "string") continue;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "image/png";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1_200_000) continue; // keep boards portable
      images.set(item.id, `data:${type};base64,${buf.toString("base64")}`);
    } catch {
      /* placeholder shape instead */
    }
  }
  return images;
}

async function main() {
  let items, connectors, title, images;
  if (args[0] === "--from-file") {
    const fixture = JSON.parse(readFileSync(args[1], "utf8"));
    items = fixture.items ?? [];
    connectors = fixture.connectors ?? [];
    title = fixture.title ?? "Imported from Miro";
  } else {
    const boardId = args[0];
    const token = process.env.MIRO_TOKEN;
    if (!boardId || !token) {
      console.error("Usage: MIRO_TOKEN=... node --import tsx scripts/import-miro.mjs <board-id> [out.json]");
      process.exit(1);
    }
    const boardRes = await fetch(`${API}/boards/${boardId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!boardRes.ok) throw new Error(`board lookup → ${boardRes.status}: ${await boardRes.text()}`);
    title = (await boardRes.json()).name ?? "Imported from Miro";
    items = await paged(`${API}/boards/${boardId}/items`, token);
    connectors = await paged(`${API}/boards/${boardId}/connectors`, token);
    images = await inlineImages(items, token);
  }

  const result = miroToBoard(items, connectors, { newId, index: "a0", images });
  const out = args[0] === "--from-file" ? (args[2] ?? "miro-import.orim.json") : (args[1] ?? `${args[0]}.orim.json`);
  writeFileSync(out, JSON.stringify(boardToJSON({ title, nodes: result.nodes, connectors: result.connectors }), null, 2));

  console.log(`✓ ${out}: ${result.nodes.length} objects, ${result.connectors.length} connectors from "${title}"`);
  const skipped = Object.entries(result.skipped);
  if (skipped.length) {
    console.log(`  skipped: ${skipped.map(([t, n]) => `${t}×${n}`).join(", ")}`);
  }
  console.log("  → drop this file onto any Orim board");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
