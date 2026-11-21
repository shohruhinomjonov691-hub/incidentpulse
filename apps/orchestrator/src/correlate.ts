import { createHash } from "node:crypto";
import type { Category, Evidence, ProjectId } from "@incidentpulse/schemas";

/**
 * Correlated incidents (SPEC §9 #13): two projects going down together often share one cause
 * (an expired shared certificate, one dead dependency). The fingerprint is built only from
 * *fault* facts in the fixed probe evidence (error codes, certificate expiry and issuer), never
 * from host names, ports, URLs or timings, so it matches across projects.
 *
 * It is deliberately conservative: it needs at least one specific token, so two unrelated "502"s
 * do not correlate.
 */

// Fixed probes only. docker_logs / pm2_logs excerpts are untrusted application text: a log line that
// says "error=CERT_HAS_EXPIRED" must not be able to make two projects look like they share a cause.
const TOOLS = new Set(["tls_inspect", "http_probe", "dns_lookup", "docker_ps"]);
const SPECIFIC = new Set(["error", "certError", "notAfter", "issuer"]);

function tokensOf(excerpt: string): string[] {
  const out: string[] = [];
  for (const key of ["error", "certError", "expired", "hostnameMatch", "chainValid"]) {
    const match = new RegExp(`\\b${key}=([A-Za-z0-9_.-]+)`).exec(excerpt);
    if (match) out.push(`${key}=${match[1]}`);
  }
  const notAfter = /\bnotAfter=(\d{4}-\d{2}-\d{2})/.exec(excerpt);
  if (notAfter) out.push(`notAfter=${notAfter[1]}`);
  const issuer = /\bissuer=(.+)$/.exec(excerpt);
  if (issuer) out.push(`issuer=${issuer[1]?.trim()}`);
  return out;
}

/** Stable key for "this kind of failure with these specific facts", or undefined if too generic. */
export function causeFingerprint(
  category: Category | undefined,
  evidence: readonly Evidence[],
): string | undefined {
  if (!category || category === "unknown") return undefined;
  const tokens = new Set<string>();
  for (const item of evidence) {
    if (!TOOLS.has(item.tool)) continue;
    for (const token of tokensOf(item.excerpt)) tokens.add(token);
  }
  const list = [...tokens].sort();
  if (!list.some((token) => SPECIFIC.has(token.slice(0, token.indexOf("="))))) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([category, list]))
    .digest("hex")
    .slice(0, 24);
}

export interface CorrelationInput {
  incidentId: string;
  project: ProjectId;
  category: Category | undefined;
  evidence: readonly Evidence[];
  at: string;
}

export interface CorrelatedGroup {
  fingerprint: string;
  incidents: string[];
  projects: ProjectId[];
}

/** Groups incidents of DIFFERENT projects with the same cause fingerprint inside a time window. */
export function correlateIncidents(
  items: readonly CorrelationInput[],
  windowMs = 10 * 60_000,
): CorrelatedGroup[] {
  const byFingerprint = new Map<string, CorrelationInput[]>();
  for (const item of items) {
    const fingerprint = causeFingerprint(item.category, item.evidence);
    if (!fingerprint) continue;
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), item]);
  }
  const groups: CorrelatedGroup[] = [];
  for (const [fingerprint, members] of byFingerprint) {
    const times = members.map((m) => Date.parse(m.at));
    const projects = [...new Set(members.map((m) => m.project))];
    if (projects.length < 2 || Math.max(...times) - Math.min(...times) > windowMs) continue;
    groups.push({ fingerprint, incidents: members.map((m) => m.incidentId), projects });
  }
  return groups;
}
