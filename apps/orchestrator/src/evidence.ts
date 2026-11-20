import { createHash } from "node:crypto";
import { CodetrailResultSchema, CommitsResultSchema } from "@incidentpulse/mcp-codetrail/schemas";
import {
  DnsLookupResultSchema,
  DockerLogsResultSchema,
  DockerPsResultSchema,
  HttpProbeResultSchema,
  TlsInspectResultSchema,
} from "@incidentpulse/mcp-infra/schemas";
import type { Redactor } from "@incidentpulse/redact";
import type { Evidence } from "@incidentpulse/schemas";

/**
 * Evidence is built by code from the *validated, scrubbed* tool result, never from what an LLM
 * says about it. The LLM can therefore cite evidence but not forge it, and text that the
 * injection guardrail removed can never reach the synthesizer or Telegram through evidence.
 */

const MAX_EXCERPT = 900;

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function oneLine(text: string, max = MAX_EXCERPT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Pulls the text payload out of whatever shape the Agents SDK gives us for an MCP result. */
export function extractToolOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (const part of output) {
      const text = extractToolOutputText(part);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (output && typeof output === "object") {
    const o = output as { text?: unknown; content?: unknown };
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return extractToolOutputText(o.content);
  }
  return undefined;
}

const REMOVED_MARK = "[line removed by guardrail";

function digestTls(r: ReturnType<typeof TlsInspectResultSchema.parse>): string {
  const head = `tls_inspect(${r.host}${r.port === 443 ? "" : `:${r.port}`})`;
  if (!r.connected) return `${head}: connected=false error=${r.error ?? "unknown"}`;
  const parts = [
    `chainValid=${r.chainValid}`,
    `hostnameMatch=${r.hostnameMatch}`,
    `expired=${r.expired}`,
    r.notAfter ? `notAfter=${r.notAfter.slice(0, 10)} (${r.daysRemaining}d)` : undefined,
    r.validationError ? `error=${r.validationError}` : undefined,
    r.subject ? `subject=${r.subject}` : undefined,
    r.sans && !(r.sans.length === 1 && r.sans[0] === r.subject)
      ? `sans=${r.sans.slice(0, 5).join(",")}`
      : undefined,
    r.issuer ? `issuer=${r.issuer}` : undefined,
  ];
  return `${head}: ${parts.filter(Boolean).join(" ")}`;
}

function digestHttp(r: ReturnType<typeof HttpProbeResultSchema.parse>): string {
  const head = `http_probe(${r.url})`;
  if (!r.completed) {
    const cert = r.certErrorCode ? ` certError=${r.certErrorCode}` : "";
    return `${head}: completed=false error=${r.error ?? "unknown"}${cert}`;
  }
  return `${head}: status=${r.status} redirects=${r.redirects.length} final=${r.finalUrl} latency=${r.latencyMs}ms`;
}

function digestDns(r: ReturnType<typeof DnsLookupResultSchema.parse>): string {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(",") : "-");
  const err = r.error ? ` error=${r.error}` : "";
  return `dns_lookup(${r.host}): A=${list(r.a)} AAAA=${list(r.aaaa)} CNAME=${list(r.cname)}${err}`;
}

function digestDockerPs(r: ReturnType<typeof DockerPsResultSchema.parse>): string {
  if (r.error) return `docker_ps: error=${r.error}`;
  if (r.containers.length === 0) return "docker_ps: no matching containers";
  return `docker_ps: ${r.containers.map((c) => `${c.name} ${c.state} (${c.status})`).join("; ")}`;
}

const INTERESTING =
  /error|fatal|emerg|crit|exception|refused|fail|panic|denied|invalid|unexpected|cannot|can't|not set|missing|timed out|killed/i;

function digestDockerLogs(r: ReturnType<typeof DockerLogsResultSchema.parse>): string {
  const head = `docker_logs(${r.container})`;
  if (r.error) return `${head}: error=${r.error}`;
  const real = r.lines.filter((l) => !l.includes(REMOVED_MARK));
  const removed = r.lines.length - real.length;
  const interesting = real.filter((l) => INTERESTING.test(l));
  // Error-like lines first (deduplicated), else the most recent lines.
  const picked = [...new Set(interesting.length > 0 ? interesting : real)].slice(-4);
  const note = removed > 0 ? ` [${removed} line(s) removed by injection guardrail]` : "";
  return `${head}: ${r.lines.length} lines${note}${picked.length > 0 ? `; key lines: ${picked.map((l) => `«${l.slice(0, 220)}»`).join(" ")}` : ""}`;
}

function digestCodetrail(tool: string, r: ReturnType<typeof CodetrailResultSchema.parse>): string {
  const head = `${tool}(${r.project})`;
  if (r.status !== "ok") return `${head}: status=${r.status}${r.error ? ` error=${r.error}` : ""}`;
  return `${head}: status=ok excerpt: ${(r.excerpt ?? "").slice(0, 500)}`;
}

function digestCommits(r: ReturnType<typeof CommitsResultSchema.parse>): string {
  const head = `git_recent_commits(${r.project})`;
  if (r.status !== "ok") return `${head}: status=${r.status}${r.error ? ` error=${r.error}` : ""}`;
  const list = (r.commits ?? [])
    .slice(0, 5)
    .map((c) => `${c.sha} «${c.message.slice(0, 100)}»${c.date ? ` ${c.date.slice(0, 10)}` : ""}`);
  return `${head}: ${r.commits?.length ?? 0} commits${list.length ? `: ${list.join("; ")}` : ""}`;
}

export function buildEvidence(args: {
  id: string;
  tool: string;
  output: unknown;
  at: Date;
  redact: Redactor;
  source?: string;
}): Evidence {
  const text = extractToolOutputText(args.output);
  let digest: string;
  let hashSource = text ?? "";

  try {
    const json: unknown = JSON.parse(text ?? "");
    const parse = <T>(schema: { parse(v: unknown): T }): T => {
      const parsed = schema.parse(json);
      hashSource = JSON.stringify(parsed);
      return parsed;
    };
    switch (args.tool) {
      case "tls_inspect":
        digest = digestTls(parse(TlsInspectResultSchema));
        break;
      case "http_probe":
        digest = digestHttp(parse(HttpProbeResultSchema));
        break;
      case "dns_lookup":
        digest = digestDns(parse(DnsLookupResultSchema));
        break;
      case "docker_ps":
        digest = digestDockerPs(parse(DockerPsResultSchema));
        break;
      case "docker_logs":
        digest = digestDockerLogs(parse(DockerLogsResultSchema));
        break;
      case "codetrail_search":
      case "codetrail_explain":
        digest = digestCodetrail(args.tool, parse(CodetrailResultSchema));
        break;
      case "git_recent_commits":
        digest = digestCommits(parse(CommitsResultSchema));
        break;
      default:
        digest = `${args.tool}: unknown tool, result not interpreted`;
    }
  } catch {
    digest = `${args.tool}: result was not valid tool output (${oneLine(text ?? "empty", 120)})`;
  }

  return {
    id: args.id,
    source: args.source ?? "mcp-infra",
    tool: args.tool,
    excerpt: args.redact(oneLine(digest)),
    at: args.at.toISOString(),
    hash: sha256(hashSource),
  };
}
