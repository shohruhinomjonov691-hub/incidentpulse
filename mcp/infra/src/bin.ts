// stdio entry point. stdout belongs to the MCP protocol: log to stderr only.

import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllowedContainers, parseAllowedHosts } from "./allowlist.ts";
import { createInfraServer } from "./server.ts";

const allowedHosts = parseAllowedHosts(process.env.INFRA_ALLOWED_HOSTS);
const allowedContainers = parseAllowedContainers(process.env.INFRA_ALLOWED_CONTAINERS);
if (allowedHosts.length === 0 && allowedContainers.length === 0) {
  console.error(
    "mcp-infra: INFRA_ALLOWED_HOSTS and INFRA_ALLOWED_CONTAINERS are both empty; refusing to start",
  );
  process.exit(1);
}
const pm2Apps = (process.env.INFRA_PM2_APPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const pm2Container = process.env.INFRA_PM2_CONTAINER?.trim() || undefined;
const timeoutMs = Number(process.env.INFRA_TIMEOUT_MS ?? 8000);

const server = createInfraServer({
  allowedHosts,
  allowedContainers,
  timeoutMs,
  ...(pm2Apps.length
    ? { pm2: { apps: pm2Apps, ...(pm2Container ? { container: pm2Container } : {}) } }
    : {}),
  redact: createRedactor({ secrets: collectSecrets(process.env) }),
});
await server.connect(new StdioServerTransport());
console.error(
  `mcp-infra ready (hosts: ${allowedHosts.join(", ") || "-"}; containers: ${allowedContainers.join(", ") || "-"}; pm2: ${pm2Apps.join(", ") || "-"})`,
);
