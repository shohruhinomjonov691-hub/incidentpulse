// stdio entry point. stdout belongs to the MCP protocol: log to stderr only.

import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { createRunnerClient } from "@incidentpulse/runner-client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllowedContainers, parseAllowedHosts } from "./allowlist.ts";
import { createDockerAdapterRunner } from "./docker-adapter/client.ts";
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
// Read-only host data (pm2, nginx -T, certbot certificates) comes from the host actions runner.
const runnerSocket = process.env.INFRA_HOST_RUNNER_SOCKET?.trim();
// Docker data comes from the docker-read-adapter (list + allowlisted logs only), never from the Docker API itself.
const dockerAdapter = process.env.INFRA_DOCKER_ADAPTER_URL?.trim();

const server = createInfraServer({
  allowedHosts,
  allowedContainers,
  timeoutMs,
  ...(runnerSocket ? { hostRunner: createRunnerClient({ socketPath: runnerSocket }) } : {}),
  ...(dockerAdapter ? { dockerRunner: createDockerAdapterRunner(dockerAdapter) } : {}),
  ...(pm2Apps.length
    ? { pm2: { apps: pm2Apps, ...(pm2Container ? { container: pm2Container } : {}) } }
    : {}),
  redact: createRedactor({ secrets: collectSecrets(process.env) }),
});
await server.connect(new StdioServerTransport());
console.error(
  `mcp-infra ready (hosts: ${allowedHosts.join(", ") || "-"}; containers: ${allowedContainers.join(", ") || "-"}; pm2: ${pm2Apps.join(", ") || "-"}; host runner: ${runnerSocket ? "yes" : "no"}; docker: ${dockerAdapter ? "adapter" : "cli"})`,
);
