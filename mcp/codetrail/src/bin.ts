// stdio entry point. stdout belongs to the MCP protocol: log to stderr only.
import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodetrailServer } from "./server.ts";

function jsonMap(name: string): Record<string, string> | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    // fall through
  }
  console.error(`mcp-codetrail: ${name} is not a JSON object; ignoring it`);
  return undefined;
}

const allowedProjects = (process.env.CODETRAIL_ALLOWED_PROJECTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = createCodetrailServer({
  allowedProjects,
  baseUrl: process.env.CODETRAIL_BASE_URL,
  apiKey: process.env.CODETRAIL_API_KEY,
  projectIds: jsonMap("CODETRAIL_PROJECT_IDS_JSON"),
  githubToken: process.env.GITHUB_READONLY_TOKEN,
  githubApiBase: process.env.GITHUB_API_BASE || undefined,
  repos: jsonMap("PROJECT_REPOS_JSON"),
  redact: createRedactor({ secrets: collectSecrets(process.env) }),
});
await server.connect(new StdioServerTransport());
console.error(
  `mcp-codetrail ready (projects: ${allowedProjects.join(", ") || "-"}; codetrail: ${process.env.CODETRAIL_BASE_URL ? "configured" : "not_configured"}; github: ${process.env.GITHUB_READONLY_TOKEN ? "configured" : "not_configured"})`,
);
