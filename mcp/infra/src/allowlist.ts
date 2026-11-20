import { isIP } from "node:net";

/**
 * Host allowlist: the permission boundary of this process. The LLM can only probe hosts the
 * operator listed, which blocks SSRF (metadata endpoints, internal services, arbitrary sites).
 */

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(normalizeHost)
    .filter((h) => h.length > 0);
}

/** Exact match, or a subdomain of an allowed domain. IP literals must match exactly. */
export function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (isIP(h)) return allowed.includes(h);
  return allowed.some((a) => h === a || (!isIP(a) && h.endsWith(`.${a}`)));
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A bare hostname or IP: no scheme, port, path or credentials. */
export function isPlainHostname(host: string): boolean {
  const h = normalizeHost(host);
  return isIP(h) !== 0 || HOSTNAME.test(h);
}
