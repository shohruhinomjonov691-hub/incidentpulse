import type { ActionScopes } from "@incidentpulse/mcp-actions";
import type { RunnerClient } from "@incidentpulse/runner-client";
import type { ProjectId } from "@incidentpulse/schemas";

export interface DomainInventory {
  domain: string;
  /**
   * Some nginx server block (any file `nginx -T` includes: sites-enabled, conf.d, ...) already names the
   * domain or, when the scope covers www, `www.<domain>`. The same rule the host helper uses to refuse
   * nginx_site_proxy, so a proposal and its refusal can never disagree.
   */
  vhost: boolean;
  /** A certbot certificate covers the domain (and www.<domain> when the scope covers www). */
  certificate: boolean;
}

export interface HostInventory {
  domains: DomainInventory[];
  /** `127.0.0.1:<port>` values the project's pm2 apps listen on, found by the host runner. */
  upstreams: Array<{ app: string; upstream: string }>;
}

/**
 * Trusted, model-free facts about the host for one project. The remediation proposer uses them to
 * decide which runbook is justified (vhost first, then certificate) and which upstream ports exist.
 * Any failure returns undefined: the proposer then falls back to the evidence-only rules.
 */
export function createHostInventory(client: RunnerClient, scopes: ActionScopes) {
  return async (project: ProjectId): Promise<HostInventory | undefined> => {
    const scope = scopes[project];
    if (!scope) return undefined;
    try {
      const [nginx, certs, ports] = await Promise.all([
        client.read("nginx_config"),
        client.read("cert_list"),
        scope.pm2?.length ? client.read("pm2_ports", { apps: scope.pm2 }) : { apps: [] },
      ]);
      const names = (domain: string) => (scope.www ? [domain, `www.${domain}`] : [domain]);
      const served = new Set(nginx.servers.flatMap((s) => s.names));
      const certified = new Set(certs.certificates.flatMap((c) => c.domains));
      return {
        domains: scope.domains.map((domain) => ({
          domain,
          vhost: names(domain).some((n) => served.has(n)),
          certificate: names(domain).every((n) => certified.has(n)),
        })),
        upstreams: ports.apps
          .filter((a) => scope.pm2?.includes(a.app))
          .flatMap((a) => a.ports.map((port) => ({ app: a.app, upstream: `127.0.0.1:${port}` }))),
      };
    } catch {
      return undefined;
    }
  };
}

export type HostInventoryReader = ReturnType<typeof createHostInventory>;
