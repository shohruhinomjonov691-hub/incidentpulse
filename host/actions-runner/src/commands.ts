import { CERTBOT_TIMEOUT_MS, type Step } from "./exec.ts";
import { helperPath, isDomain, type Policy, type ProjectPolicy } from "./policy.ts";

/**
 * Runbook id + parameters -> fixed commands. This table is the runner's own copy of runbooks/*.yaml
 * (a parity test keeps them aligned); it is the authority on the host, whatever the orchestrator sent.
 */

export const RUNBOOK_IDS = [
  "certbot_renew",
  "certbot_nginx_issue",
  "nginx_reload",
  "docker_restart",
  "pm2_restart",
  "docker_compose_up",
  "nginx_site_proxy",
] as const;
export type RunbookId = (typeof RUNBOOK_IDS)[number];

export class Denied extends Error {}

export interface ResolvedRunbook {
  runbookId: RunbookId;
  risk: "low" | "medium";
  dryRun: Step[];
  run: Step[];
  /** Defaults to step zero. Set when the run opens with a read-only command. */
  firstMutationStep?: number;
  /**
   * Static pre-approval checks done by the runner (no certbot staging run, nothing touches the live nginx):
   *  - certbot_nginx_issue: the vhost exists, DNS A points at this server, the certificate is missing or stale.
   *  - certbot_renew: a certificate for the domain exists.
   */
  prerequisite?: "vhost_dns_certificate_missing_or_stale" | "certificate_present";
  /** nginx_site_proxy: the upstream is verified against the project's pm2 apps before anything runs. */
  upstream?: { host: "127.0.0.1"; port: number };
  domain?: string;
}

const UPSTREAM = /^127\.0\.0\.1:([1-9]\d{3,4})$/;

export function parseUpstream(value: string, min: number): { host: "127.0.0.1"; port: number } {
  const port = Number(UPSTREAM.exec(value)?.[1]);
  if (!Number.isInteger(port) || port < min || port > 65535) {
    throw new Denied(`Upstream must be 127.0.0.1:<port> with a port from ${min} to 65535`);
  }
  return { host: "127.0.0.1", port };
}

function exactKeys(params: Record<string, string>, keys: string[]) {
  const given = Object.keys(params).sort();
  if (given.length !== keys.length || given.some((k, i) => k !== [...keys].sort()[i])) {
    throw new Denied(`Parameters must be exactly: ${keys.join(", ") || "(none)"}`);
  }
  for (const value of Object.values(params)) {
    if (typeof value !== "string") throw new Denied("Parameters must be strings");
  }
}

function pick(list: readonly string[], value: string | undefined, what: string): string {
  if (!value || !list.includes(value)) throw new Denied(`${what} is not in the project's policy`);
  return value;
}

const domainArgs = (domain: string, project: ProjectPolicy) =>
  project.www ? ["-d", domain, "-d", `www.${domain}`] : ["-d", domain];

const sudoStep = (bin: Step["bin"], args: string[], timeoutMs?: number): Step => ({
  bin,
  args,
  sudo: true,
  ...(timeoutMs ? { timeoutMs } : {}),
});

export function resolveRunbook(
  policy: Policy,
  projectId: string,
  runbookId: string,
  params: Record<string, string>,
): ResolvedRunbook {
  const project = policy.projects[projectId];
  if (!project) throw new Denied("Project is not in the policy");
  const id = RUNBOOK_IDS.find((r) => r === runbookId);
  if (!id) throw new Denied("Unknown runbook");

  switch (id) {
    case "certbot_renew": {
      exactKeys(params, ["domain"]);
      const domain = pick(project.domains, params.domain, "Domain");
      const renew = (...extra: string[]) => [
        "renew",
        "--cert-name",
        domain,
        ...extra,
        "--non-interactive",
        "--no-directory-hooks",
      ];
      return {
        runbookId: id,
        risk: "low",
        domain,
        prerequisite: "certificate_present",
        // Pre-approval is static. `certbot renew --dry-run` may use the nginx authenticator, which edits and
        // reloads the live nginx, so it runs only AFTER approval, as the first step of the run.
        dryRun: [sudoStep("nginx", ["-t"])],
        run: [
          sudoStep("certbot", renew("--dry-run"), CERTBOT_TIMEOUT_MS),
          sudoStep("certbot", renew(), CERTBOT_TIMEOUT_MS),
          sudoStep("nginx", ["-t"]),
          sudoStep("systemctl", ["reload", "nginx"]),
        ],
      };
    }
    case "certbot_nginx_issue": {
      exactKeys(params, ["domain"]);
      const domain = pick(project.domains, params.domain, "Domain");
      if (!project.nginx || !project.webroot) throw new Denied("nginx and webroot are not enabled");
      return {
        runbookId: id,
        risk: "medium",
        domain,
        prerequisite: "vhost_dns_certificate_missing_or_stale",
        // Pre-approval is static (the runner checks vhost, DNS and certificate inventory). The staging run
        // `certonly --dry-run --nginx` temporarily edits and reloads the LIVE nginx, so it is the FIRST step
        // after approval; a failure stops the run before the real issuance.
        dryRun: [sudoStep("nginx", ["-t"])],
        run: [
          sudoStep(
            "certbot",
            // Same authenticator as the real run: a pre-existing vhost has no ACME webroot location.
            [
              "certonly",
              "--dry-run",
              "--non-interactive",
              "--nginx",
              ...domainArgs(domain, project),
            ],
            CERTBOT_TIMEOUT_MS,
          ),
          sudoStep(
            "certbot",
            ["--nginx", ...domainArgs(domain, project), "--non-interactive", "--redirect"],
            CERTBOT_TIMEOUT_MS,
          ),
          sudoStep("nginx", ["-t"]),
        ],
      };
    }
    case "nginx_reload": {
      exactKeys(params, []);
      if (!project.nginx) throw new Denied("nginx is not enabled for this project");
      return {
        runbookId: id,
        risk: "low",
        dryRun: [sudoStep("nginx", ["-t"])],
        run: [sudoStep("nginx", ["-t"]), sudoStep("systemctl", ["reload", "nginx"])],
        firstMutationStep: 1,
      };
    }
    case "docker_restart": {
      exactKeys(params, ["service"]);
      const service = pick(project.containers, params.service, "Container");
      return {
        runbookId: id,
        risk: "low",
        dryRun: [
          sudoStep("docker", ["inspect", "--format", "{{.Name}} {{.State.Status}}", service]),
        ],
        run: [sudoStep("docker", ["restart", service])],
      };
    }
    case "pm2_restart": {
      exactKeys(params, ["app"]);
      const app = pick(project.pm2, params.app, "pm2 app");
      return {
        runbookId: id,
        risk: "low",
        dryRun: [sudoStep("pm2", ["describe", app])],
        run: [sudoStep("pm2", ["restart", app])],
      };
    }
    case "docker_compose_up": {
      exactKeys(params, ["project"]);
      const compose = project.compose;
      if (!compose || params.project !== compose.name) {
        throw new Denied("Compose stack is not in the project's policy");
      }
      const base = ["compose", "-f", compose.file, "-p", compose.name];
      return {
        runbookId: id,
        risk: "medium",
        dryRun: [sudoStep("docker", [...base, "config", "--quiet"])],
        run: [sudoStep("docker", [...base, "up", "-d"])],
      };
    }
    case "nginx_site_proxy": {
      exactKeys(params, ["domain", "upstream"]);
      const domain = pick(project.domains, params.domain, "Domain");
      if (!project.nginx || !project.webroot) throw new Denied("nginx and webroot are not enabled");
      const upstream = parseUpstream(params.upstream as string, policy.upstreamPortMin);
      const helper = (mode: "check" | "apply") =>
        sudoStep(
          "node",
          [helperPath(policy), mode, domain, `${upstream.host}:${upstream.port}`],
          120_000,
        );
      return {
        runbookId: id,
        risk: "medium",
        domain,
        upstream,
        dryRun: [helper("check")],
        run: [helper("apply")],
      };
    }
  }
}

// ------------------------------------------------------------------ read-only steps

export const READ_STEPS = {
  pm2Jlist: sudoStep("pm2", ["jlist"]),
  pm2Logs: (app: string) => sudoStep("pm2", ["logs", app, "--nostream", "--lines", "200"]),
  nginxDump: sudoStep("nginx", ["-T"]),
  certificates: sudoStep("certbot", ["certificates"]),
  listeners: sudoStep("ss", ["-H", "-ltnp"]),
  processTree: { bin: "ps", args: ["-eo", "pid=,ppid="], sudo: false } satisfies Step,
};

// ------------------------------------------------------------------------ sudoers

/** Every privileged step the runner can ever issue for this policy: the sudoers allowlist. */
export function privilegedSteps(policy: Policy): Step[] {
  const steps: Step[] = [
    READ_STEPS.pm2Jlist,
    READ_STEPS.nginxDump,
    READ_STEPS.certificates,
    READ_STEPS.listeners,
  ];
  const apps = new Set<string>();
  for (const [projectId, project] of Object.entries(policy.projects)) {
    for (const app of project.pm2) apps.add(app);
    const add = (runbookId: RunbookId, params: Record<string, string>) => {
      try {
        const book = resolveRunbook(policy, projectId, runbookId, params);
        steps.push(...book.dryRun, ...book.run);
      } catch (error) {
        if (!(error instanceof Denied)) throw error;
      }
    };
    for (const domain of project.domains) {
      add("certbot_renew", { domain });
      add("certbot_nginx_issue", { domain });
    }
    add("nginx_reload", {});
    for (const service of project.containers) add("docker_restart", { service });
    for (const app of project.pm2) add("pm2_restart", { app });
    if (project.compose) add("docker_compose_up", { project: project.compose.name });
  }
  for (const app of apps) steps.push(READ_STEPS.pm2Logs(app));
  return steps.filter((s) => s.sudo);
}

/** nginx_site_proxy takes a runtime port, so it is the one place sudoers uses a character-class pattern. */
export function siteHelperRules(policy: Policy): string[] {
  const rules: string[] = [];
  for (const project of Object.values(policy.projects)) {
    if (!project.nginx || !project.webroot) continue;
    for (const domain of project.domains) {
      if (!isDomain(domain)) continue;
      for (const mode of ["check", "apply"]) {
        for (const digits of [4, 5]) {
          const port = "[0-9]".repeat(digits);
          rules.push(
            `${policy.bins.node} ${helperPath(policy)} ${mode} ${domain} 127.0.0.1\\:${port}`,
          );
        }
      }
    }
  }
  return rules;
}
