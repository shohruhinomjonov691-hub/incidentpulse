import type { Redactor } from "@incidentpulse/redact";
import { type RunnerClient, RunnerError } from "@incidentpulse/runner-client";
import {
  type CertListResult,
  CertListResultSchema,
  type NginxConfigResult,
  NginxConfigResultSchema,
  type Pm2LogsResult,
  Pm2LogsResultSchema,
  type Pm2PortsResult,
  Pm2PortsResultSchema,
} from "../schemas.ts";
import type { Pm2Runner } from "./pm2.ts";
import { isValidPm2App } from "./pm2.ts";

/**
 * Read-only host data through the host actions runner (pm2, nginx -T, certbot certificates).
 * The runner applies its own policy; the allowlists here are a second, independent filter.
 */

const MAX_TOTAL_CHARS = 24_000;
const code = (error: unknown) => (error instanceof RunnerError ? error.code : "RUNNER_ERROR");

/** A `Pm2Runner` that asks the host runner instead of spawning `pm2` (which a container does not have). */
export function hostPm2(client: RunnerClient): Pm2Runner {
  return {
    async jlist() {
      const { apps } = await client.read("pm2_jlist");
      // Same shape as `pm2 jlist`, so the existing parser and allowlist filter apply unchanged.
      return JSON.stringify(
        apps.map((a) => ({
          name: a.name,
          pid: a.pid,
          pm2_env: { status: a.status, restart_time: a.restarts, pm_uptime: a.since },
        })),
      );
    },
  };
}

export async function pm2Logs(
  client: RunnerClient,
  app: string,
  options: { lines: number; allowedApps: readonly string[]; redact: Redactor },
): Promise<Pm2LogsResult> {
  if (!isValidPm2App(app) || !options.allowedApps.includes(app)) {
    return Pm2LogsResultSchema.parse({ app, lines: [], error: "NOT_ALLOWED" });
  }
  try {
    const read = await client.read("pm2_logs", { app, lines: options.lines });
    const kept: string[] = [];
    let total = 0;
    for (const line of [...read.lines].reverse()) {
      total += line.length;
      if (total > MAX_TOTAL_CHARS) break;
      kept.unshift(options.redact(line));
    }
    return Pm2LogsResultSchema.parse({ app, lines: kept });
  } catch (error) {
    return Pm2LogsResultSchema.parse({ app, lines: [], error: code(error) });
  }
}

export async function pm2Ports(
  client: RunnerClient,
  allowedApps: readonly string[],
): Promise<Pm2PortsResult> {
  try {
    const read = await client.read("pm2_ports", { apps: allowedApps });
    return Pm2PortsResultSchema.parse({
      apps: read.apps
        .filter((a) => allowedApps.includes(a.app))
        .map((a) => ({
          name: a.app,
          ...(a.pid === undefined ? {} : { pid: a.pid }),
          ports: a.ports,
        })),
    });
  } catch (error) {
    return Pm2PortsResultSchema.parse({ apps: [], error: code(error) });
  }
}

const inScope = (name: string, host: string) => name === host || name === `www.${host}`;

/** Which allowlisted hosts have an nginx server block (and how it listens / where it proxies). */
export async function nginxConfig(
  client: RunnerClient,
  hosts: readonly string[],
): Promise<NginxConfigResult> {
  try {
    const { servers } = await client.read("nginx_config");
    return NginxConfigResultSchema.parse({
      hosts: hosts.map((host) => {
        const matching = servers.filter((s) => s.names.some((n) => inScope(n, host)));
        return {
          host,
          vhost: servers.some((s) => s.names.includes(host)),
          listens: [...new Set(matching.flatMap((s) => s.listens))].slice(0, 6),
          ssl: matching.some((s) => s.ssl),
          proxyPass: [...new Set(matching.flatMap((s) => s.proxyPass))].slice(0, 4),
        };
      }),
    });
  } catch (error) {
    return NginxConfigResultSchema.parse({ hosts: [], error: code(error) });
  }
}

/** Which allowlisted hosts are covered by a certbot certificate, and until when. */
export async function certList(
  client: RunnerClient,
  hosts: readonly string[],
): Promise<CertListResult> {
  try {
    const { certificates } = await client.read("cert_list");
    return CertListResultSchema.parse({
      hosts: hosts.map((host) => {
        const cert = certificates.find((c) => c.domains.includes(host));
        return cert
          ? {
              host,
              certificate: true,
              name: cert.name,
              ...(cert.expiresAt ? { expiresAt: cert.expiresAt } : {}),
              ...(cert.daysRemaining === undefined ? {} : { daysRemaining: cert.daysRemaining }),
              valid: cert.valid,
            }
          : { host, certificate: false };
      }),
    });
  } catch (error) {
    return CertListResultSchema.parse({ hosts: [], error: code(error) });
  }
}
