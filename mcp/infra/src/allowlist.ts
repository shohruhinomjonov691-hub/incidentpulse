import { isIP } from "node:net";

/**
 * Host allowlist: the permission boundary of this process. The LLM can only probe hosts the
 * operator listed, which blocks SSRF (metadata endpoints, internal services, arbitrary sites).
 *
 * An entry is `host` (exact host or a subdomain; ports 80 and 443 only) or `host:port`
 * (that one port only). So an allowed host can never be used as a port scanner.
 */

export const DEFAULT_PORTS: readonly number[] = [80, 443];

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(normalizeHost)
    .filter((h) => h.length > 0);
}

interface Entry {
  host: string;
  port: number | undefined;
}

function parseEntry(entry: string): Entry {
  const match = /^(.+):(\d{1,5})$/.exec(entry);
  if (match && !isIP(entry)) return { host: match[1] as string, port: Number(match[2]) };
  return { host: entry, port: undefined };
}

function hostMatches(host: string, allowedHost: string): boolean {
  if (isIP(host)) return host === allowedHost;
  return host === allowedHost || (!isIP(allowedHost) && host.endsWith(`.${allowedHost}`));
}

/** Host-only check (DNS has no port). Any entry for the host counts, whatever its port. */
export function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return allowed.some((a) => hostMatches(h, parseEntry(a).host));
}

/** Host + port check used by tls_inspect and http_probe. */
export function isAllowedTarget(host: string, port: number, allowed: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h || !Number.isInteger(port)) return false;
  return allowed.some((a) => {
    const e = parseEntry(a);
    if (!hostMatches(h, e.host)) return false;
    return e.port === undefined ? DEFAULT_PORTS.includes(port) : e.port === port;
  });
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A bare hostname or IP: no scheme, port, path or credentials. */
export function isPlainHostname(host: string): boolean {
  const h = normalizeHost(host);
  return isIP(h) !== 0 || HOSTNAME.test(h);
}

// ------------------------------------------------------------------ containers

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function isValidContainerName(name: string): boolean {
  return CONTAINER_NAME.test(name);
}

/** An entry matches a container whose name equals it or starts with it (e.g. "ipsb-a-"). */
export function isAllowedContainer(name: string, allowed: readonly string[]): boolean {
  return isValidContainerName(name) && allowed.some((a) => a.length > 0 && name.startsWith(a));
}

export function parseAllowedContainers(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
