import { loadOrchestratorConfig } from "@incidentpulse/config";
import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { createLogger } from "./log.ts";
import { startRuntime } from "./runtime.ts";

const config = loadOrchestratorConfig();
const redact = createRedactor({ secrets: collectSecrets(process.env) });
const runtime = await startRuntime({ config, redact, log: createLogger(redact) });
const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
