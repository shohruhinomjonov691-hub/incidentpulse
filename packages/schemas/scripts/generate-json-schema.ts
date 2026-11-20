// Generates json/*.schema.json from the zod schemas (consumed by the Python services).
// Run: pnpm --filter @incidentpulse/schemas generate   (Node 24 runs .ts natively)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS, renderJsonSchema } from "../src/json-schema.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "json");
mkdirSync(outDir, { recursive: true });

for (const [file, schema] of Object.entries(CONTRACTS)) {
  writeFileSync(join(outDir, file), renderJsonSchema(schema));
  console.log(`wrote json/${file}`);
}
