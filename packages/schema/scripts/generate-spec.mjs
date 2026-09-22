// Generates the machine-readable format spec (JSON Schema) from the zod
// source of truth, and validates the spec site's example board against it.
// Run from packages/schema:  node --import tsx scripts/generate-spec.mjs
import { writeFileSync, readFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BoardDoc, Node, Connector, BoardComment, SCHEMA_VERSION, parseBoard,
} from "../src/index.ts";

const out = new URL("../../../docs/", import.meta.url).pathname;

const schema = zodToJsonSchema(BoardDoc, {
  name: "OrimBoard",
  definitions: { Node, Connector, Comment: BoardComment },
});
schema.$comment = `Orim board format, schemaVersion ${SCHEMA_VERSION}. Generated from @orim/schema — do not edit by hand.`;
writeFileSync(`${out}orim.schema.json`, JSON.stringify(schema, null, 2));
console.log(`wrote docs/orim.schema.json (schemaVersion ${SCHEMA_VERSION})`);

// The example on the spec site must always parse.
const example = JSON.parse(readFileSync(`${out}example-board.json`, "utf8"));
parseBoard(example);
console.log("docs/example-board.json validates ✓");
