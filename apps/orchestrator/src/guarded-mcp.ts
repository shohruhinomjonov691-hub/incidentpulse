import { MCPServerStdio } from "@openai/agents";

type MCPServerStdioOptions = ConstructorParameters<typeof MCPServerStdio>[0];

import { guardToolOutput, type InjectionMode } from "./guardrails.ts";

/** One tool call as seen by the guarded server. `rawText` is already scrubbed (strip mode). */
export interface ToolCallRecord {
  tool: string;
  /** Scrubbed text: safe for evidence and reports. */
  scrubbedText: string;
  flags: string[];
  flaggedCount: number;
  /** The MCP server refused the call (target outside its allowlist / not permitted). */
  blocked: boolean;
}

const BLOCKED = [
  /not in this server's allowlist/i,
  /"error"\s*:\s*"(HOST_NOT_ALLOWED|NOT_ALLOWED|PROJECT_NOT_ALLOWED)"/,
  /"status"\s*:\s*"denied"/,
];

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
    )
    .join("\n");
}

export interface GuardedMcpOptions {
  mode: InjectionMode;
  /** Label used in the <untrusted source="..."> wrapper. */
  source: string;
}

/**
 * An MCP stdio server whose tool results pass through the INPUT guardrail before the agent sees
 * them, and which records every call so evidence can be built from the scrubbed raw result.
 */
export class GuardedMcpServer extends MCPServerStdio {
  readonly calls: ToolCallRecord[] = [];
  private readonly guard: GuardedMcpOptions;

  constructor(options: MCPServerStdioOptions, guard: GuardedMcpOptions) {
    super(options);
    this.guard = guard;
  }

  override async callTool(
    ...args: Parameters<MCPServerStdio["callTool"]>
  ): ReturnType<MCPServerStdio["callTool"]> {
    const content = await super.callTool(...args);
    const raw = textOf(content);
    const guarded = guardToolOutput(raw, {
      source: `${this.guard.source}/${args[0]}`,
      mode: this.guard.mode,
    });
    this.calls.push({
      tool: args[0],
      scrubbedText: guarded.scrubbedText,
      flags: guarded.flags,
      flaggedCount: guarded.flaggedCount,
      blocked: BLOCKED.some((re) => re.test(raw)),
    });
    return [{ type: "text", text: guarded.modelText }] as unknown as Awaited<
      ReturnType<MCPServerStdio["callTool"]>
    >;
  }
}
