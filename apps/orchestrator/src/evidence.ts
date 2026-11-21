import { createHash } from "node:crypto";
import { CodetrailResultSchema, CommitsResultSchema } from "@incidentpulse/mcp-codetrail/schemas";
import {
  CertListResultSchema,
  DnsLookupResultSchema,
  DockerLogsResultSchema,
  DockerPsResultSchema,
  HttpProbeResultSchema,
  NginxConfigResultSchema,
  Pm2ListResultSchema,
  Pm2LogsResultSchema,
  Pm2PortsResultSchema,
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
  /error|fatal|emerg|crit|exception|refused|fail|panic|denied|invalid|unexpected|cannot|can't|not set|missing|timed out|killed|enospc|no space left|out of memory|oom/i;

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

function digestPm2(r: ReturnType<typeof Pm2ListResultSchema.parse>): string {
  if (r.error) return `pm2_list: error=${r.error}`;
  if (r.apps.length === 0) return "pm2_list: no matching apps";
  return `pm2_list: ${r.apps
    .map(
      (a) =>
        `${a.name} ${a.status} (restarts=${a.restarts}${a.uptimeSeconds === undefined ? "" : `, up ${a.uptimeSeconds}s`})`,
    )
    .join("; ")}`;
}

function digestPm2Logs(r: ReturnType<typeof Pm2LogsResultSchema.parse>): string {
  const head = `pm2_logs(${r.app})`;
  if (r.error) return `${head}: error=${r.error}`;
  const interesting = r.lines.filter((l) => INTERESTING.test(l));
  const picked = [...new Set(interesting.length > 0 ? interesting : r.lines)].slice(-4);
  return `${head}: ${r.lines.length} lines${picked.length > 0 ? `; key lines: ${picked.map((l) => `«${l.slice(0, 220)}»`).join(" ")}` : ""}`;
}

function digestPm2Ports(r: ReturnType<typeof Pm2PortsResultSchema.parse>): string {
  if (r.error) return `pm2_ports: error=${r.error}`;
  if (r.apps.length === 0) return "pm2_ports: no matching apps";
  return `pm2_ports: ${r.apps.map((a) => `${a.name} ports=${a.ports.length > 0 ? a.ports.join(",") : "none"}`).join("; ")}`;
}

// `vhost=missing` / `cert=missing` are the markers the remediation proposer and the reports key on.
function digestNginxConfig(r: ReturnType<typeof NginxConfigResultSchema.parse>): string {
  if (r.error) return `nginx_config: error=${r.error}`;
  return `nginx_config: ${r.hosts
    .map((h) =>
      h.vhost
        ? `${h.host} vhost=present listen=${h.listens.join(",") || "-"} ssl=${h.ssl}${h.proxyPass.length ? ` proxy=${h.proxyPass.join(",")}` : ""}`
        : `${h.host} vhost=missing`,
    )
    .join("; ")}`;
}

function digestCertList(r: ReturnType<typeof CertListResultSchema.parse>): string {
  if (r.error) return `cert_list: error=${r.error}`;
  return `cert_list: ${r.hosts
    .map((h) =>
      h.certificate
        ? `${h.host} cert=present${h.expiresAt ? ` notAfter=${h.expiresAt.slice(0, 10)}` : ""}${h.valid === false ? " valid=false" : ""}`
        : `${h.host} cert=missing`,
    )
    .join("; ")}`;
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
      case "pm2_list":
        digest = digestPm2(parse(Pm2ListResultSchema));
        break;
      case "pm2_logs":
        digest = digestPm2Logs(parse(Pm2LogsResultSchema));
        break;
      case "pm2_ports":
        digest = digestPm2Ports(parse(Pm2PortsResultSchema));
        break;
      case "nginx_config":
        digest = digestNginxConfig(parse(NginxConfigResultSchema));
        break;
      case "cert_list":
        digest = digestCertList(parse(CertListResultSchema));
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

/** Keep a single citation for the same diagnostic fact even when probe timing differs. */
export function evidenceForModel(items: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const fact = item.excerpt
      .replace(/ latency=\d+(?:\.\d+)?ms\b/, "")
      .replace(/(notAfter=\d{4}-\d{2}-\d{2}) \(-?\d+d\)/, "$1")
      .replace(/, up \d+s\)/g, ")");
    const key = JSON.stringify([item.tool, fact]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function logSignatures(lines: string[]): string[] {
  return [
    ...new Set(
      lines
        .filter((line) => !line.includes(REMOVED_MARK) && INTERESTING.test(line))
        .map((line) =>
          oneLine(
            line
              .replace(/\b\d{4}[-/]\d\d[-/]\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?/g, "")
              .replace(/\b\d+#\d+:\s*\*\d+\s*/g, "")
              .replace(/, client: [^,]+/g, "")
              .replace(/\b(?:request[_ -]?id|trace[_ -]?id)[=: ]+\S+/gi, ""),
            220,
          ),
        )
        .filter(Boolean),
    ),
  ]
    .slice(-4)
    .sort();
}
