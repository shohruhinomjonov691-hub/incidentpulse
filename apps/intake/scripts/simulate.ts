// Sends a correctly signed "project is down" signal to the local intake.
// Usage: pnpm incident:simulate --project kervan [--check https] [--summary "..."]
import { parseArgs } from "node:util";
import { loadSimulateConfig } from "@incidentpulse/config";
import { PROJECT_DISPLAY_NAMES, ProjectIdSchema } from "@incidentpulse/schemas";
import { SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from "../src/signature.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    check: { type: "string", default: "https" },
    summary: { type: "string" },
  },
});

const project = ProjectIdSchema.safeParse(values.project);
if (!project.success) {
  console.error(`--project is required, one of: ${ProjectIdSchema.options.join(", ")}`);
  process.exit(2);
}

const config = loadSimulateConfig(process.env);
const body = JSON.stringify({
  project: project.data,
  check: values.check,
  level: "down",
  summary: values.summary ?? `${PROJECT_DISPLAY_NAMES[project.data]}: HTTPS health check failed`,
  at: new Date().toISOString(),
});
const timestamp = String(Math.floor(Date.now() / 1000));
const url = `http://${config.host}:${config.port}/webhook/monitor`;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sign(config.hmacSecret, timestamp, body),
  },
  body,
});
console.log(`POST ${url} -> ${response.status} ${await response.text()}`);
process.exit(response.ok ? 0 : 1);
