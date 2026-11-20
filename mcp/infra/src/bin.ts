// stdio entry point. stdout belongs to the MCP protocol: log to stderr only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllowedHosts } from "./allowlist.ts";
import { createInfraServer } from "./server.ts";

const allowedHosts = parseAllowedHosts(process.env.INFRA_ALLOWED_HOSTS);
if (allowedHosts.length === 0) {
  console.error("mcp-infra: INFRA_ALLOWED_HOSTS is empty; refusing to start with nothing to probe");
  process.exit(1);
}
const timeoutMs = Number(process.env.INFRA_TIMEOUT_MS ?? 8000);

const server = createInfraServer({ allowedHosts, timeoutMs });
await server.connect(new StdioServerTransport());
console.error(`mcp-infra ready (allowed: ${allowedHosts.join(", ")})`);
