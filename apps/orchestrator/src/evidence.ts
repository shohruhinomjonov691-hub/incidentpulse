import { createHash } from "node:crypto";
import {
  DnsLookupResultSchema,
  HttpProbeResultSchema,
  TlsInspectResultSchema,
} from "@incidentpulse/mcp-infra/schemas";
import type { Redactor } from "@incidentpulse/redact";
import type { Evidence } from "@incidentpulse/schemas";

/**
 * Evidence is built by code from the *validated* tool result, never from what the LLM says
 * about it. The LLM can therefore cite evidence but not forge it.
 */

const MAX_EXCERPT = 600;

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

function digestTls(r: ReturnType<typeof TlsInspectResultSchema.parse>): string {
  const head = `tls_inspect(${r.host})`;
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

export function buildEvidence(args: {
  id: string;
  tool: string;
  output: unknown;
  at: Date;
  redact: Redactor;
}): Evidence {
  const text = extractToolOutputText(args.output);
  let digest: string;
  let hashSource = text ?? "";

  try {
    const json: unknown = JSON.parse(text ?? "");
    switch (args.tool) {
      case "tls_inspect": {
        const parsed = TlsInspectResultSchema.parse(json);
        digest = digestTls(parsed);
        hashSource = JSON.stringify(parsed);
        break;
      }
      case "http_probe": {
        const parsed = HttpProbeResultSchema.parse(json);
        digest = digestHttp(parsed);
        hashSource = JSON.stringify(parsed);
        break;
      }
      case "dns_lookup": {
        const parsed = DnsLookupResultSchema.parse(json);
        digest = digestDns(parsed);
        hashSource = JSON.stringify(parsed);
        break;
      }
      default:
        digest = `${args.tool}: unknown tool, result not interpreted`;
    }
  } catch {
    digest = `${args.tool}: result was not valid tool output (${oneLine(text ?? "empty", 120)})`;
  }

  return {
    id: args.id,
    source: "mcp-infra",
    tool: args.tool,
    excerpt: args.redact(oneLine(digest)),
    at: args.at.toISOString(),
    hash: sha256(hashSource),
  };
}
