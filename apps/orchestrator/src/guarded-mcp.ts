import { AsyncLocalStorage } from "node:async_hooks";
import type { Redactor } from "@incidentpulse/redact";
import { MCPServerStdio } from "@openai/agents";

type MCPServerStdioOptions = ConstructorParameters<typeof MCPServerStdio>[0];

import { buildEvidence } from "./evidence.ts";
import { detectInjection, guardToolOutput, type InjectionMode } from "./guardrails.ts";
import { telemetry } from "./observability.ts";

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
  redact: Redactor;
}

export const toolJournal = new AsyncLocalStorage<
  (event: { tool: string; source: string; excerpt: string; blocked: boolean }) => Promise<void>
>();

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
    const callStarted = new Date();
    const content = await super.callTool(...args);
    const raw = textOf(content);
    const guarded = guardToolOutput(raw, {
      source: `${this.guard.source}/${args[0]}`,
      mode: this.guard.mode,
      compact: (body) => {
        const digest = buildEvidence({
          id: "",
          tool: args[0],
          output: body,
          at: new Date(),
          redact: this.guard.redact,
        }).excerpt;
        if (this.guard.mode !== "mark" || detectInjection(body).length === 0) return digest;
        // Keep a sample of marked lines in the model context even when the diagnostic digest omits them.
        let lines = [body];
        if (args[0] === "docker_logs") {
          try {
            const value = JSON.parse(body);
            if (Array.isArray(value?.lines))
              lines = value.lines.filter((line: unknown) => typeof line === "string");
          } catch {
            // Non-JSON errors use the same bounded fallback.
          }
        }
        const marked = lines
          .filter((line) => detectInjection(line).length > 0)
          .map((line) => line.slice(0, 450));
        return this.guard.redact([digest, ...new Set(marked)].join("\n").slice(0, 1500));
      },
    });
    const blocked = BLOCKED.some((re) => re.test(raw));
    this.calls.push({
      tool: args[0],
      scrubbedText: guarded.scrubbedText,
      flags: guarded.flags,
      flaggedCount: guarded.flaggedCount,
      blocked,
    });
    const tracer = telemetry();
    if (tracer.enabled) {
      tracer.tool({
        name: args[0],
        source: this.guard.source,
        input: args[1],
        // The scrubbed digest, never the raw tool output.
        output: buildEvidence({
          id: "",
          tool: args[0],
          output: guarded.scrubbedText,
          at: new Date(),
          redact: this.guard.redact,
        }).excerpt,
        blocked,
        startTime: callStarted,
        endTime: new Date(),
      });
    }
    const record = toolJournal.getStore();
    if (record)
      await record({
        tool: args[0],
        source: this.guard.source,
        blocked,
        excerpt: buildEvidence({
          id: "",
          tool: args[0],
          output: guarded.scrubbedText,
          at: new Date(),
          redact: this.guard.redact,
        }).excerpt,
      });
    return [{ type: "text", text: guarded.modelText }] as unknown as Awaited<
      ReturnType<MCPServerStdio["callTool"]>
    >;
  }
}
