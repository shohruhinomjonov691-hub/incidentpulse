// Test double for mcp-infra: the real server and tools, but `docker` is replaced by canned output
// taken from the environment. Spawned over stdio by the specialist tests.

import {
  createInfraServer,
  parseAllowedContainers,
  parseAllowedHosts,
} from "@incidentpulse/mcp-infra";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const ps = process.env.FAKE_DOCKER_PS ?? "";
const logs = process.env.FAKE_DOCKER_LOGS ?? "";

const server = createInfraServer({
  allowedHosts: parseAllowedHosts(process.env.INFRA_ALLOWED_HOSTS),
  allowedContainers: parseAllowedContainers(process.env.INFRA_ALLOWED_CONTAINERS),
  dockerRunner: async (args) => ({
    stdout: args[0] === "ps" ? ps : logs,
    stderr: "",
  }),
});
await server.connect(new StdioServerTransport());
