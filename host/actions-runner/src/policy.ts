/**
 * Runner policy: the host's OWN allowlist, independent of the orchestrator's configuration.
 * A request that the orchestrator would allow but this file does not list is refused. Parsed by
 * hand (the runner has no dependencies) and validated strictly: unknown keys are errors.
 */

import { isIP } from "node:net";

export const BIN_NAMES = [
  "sudo",
  "certbot",
  "nginx",
  "systemctl",
  "docker",
  "pm2",
  "ss",
  "ps",
  "tar",
  "node",
] as const;
export type BinName = (typeof BIN_NAMES)[number];
export type Bins = Record<BinName, string>;

export const DEFAULT_BINS: Bins = {
  sudo: "/usr/bin/sudo",
  certbot: "/usr/bin/certbot",
  nginx: "/usr/sbin/nginx",
  systemctl: "/usr/bin/systemctl",
  docker: "/usr/bin/docker",
  pm2: "/usr/bin/pm2",
  ss: "/usr/bin/ss",
  ps: "/usr/bin/ps",
  tar: "/usr/bin/tar",
  node: "/opt/incidentpulse/node/bin/node",
};

/** Where the (root-owned) installed copy of the runner lives; the sudoers file points at it. */
export const DEFAULT_INSTALL_DIR = "/opt/incidentpulse/actions-runner";

export interface ProjectPolicy {
  /** Exact certificate/vhost domains (apex names). Lower case, no port. */
  domains: string[];
  /** Also cover `www.<domain>` for certbot_nginx_issue and nginx_site_proxy. */
  www: boolean;
  /** Exact Docker container names that may be restarted. */
  containers: string[];
  /** Exact pm2 app names (read, restart, upstream discovery). */
  pm2: string[];
  /** nginx_reload / nginx_site_proxy allowed for this project. */
  nginx: boolean;
  /** ACME webroot written into vhosts that nginx_site_proxy creates (certbot_nginx_issue uses the nginx authenticator). */
  webroot?: string;
  compose?: { name: string; file: string };
}

export interface Policy {
  projects: Record<string, ProjectPolicy>;
  bins: Bins;
  installDir: string;
  /** Lowest upstream port nginx_site_proxy may point at. */
  upstreamPortMin: number;
  /**
   * This server's public IPv4 addresses: the A records of a domain must point here before certbot_nginx_issue
   * is approved. Unset = every non-internal IPv4 address of the host's network interfaces.
   */
  publicIps?: string[];
}

const DOMAIN =
  /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/;
const ABS_PATH = /^\/[A-Za-z0-9_./-]{1,200}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class PolicyError extends Error {}

export function isDomain(value: string): boolean {
  return DOMAIN.test(value);
}
export function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value);
}
export function isAbsolutePath(value: string): boolean {
  return ABS_PATH.test(value) && !value.split("/").some((part) => part === "..");
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function noExtraKeys(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PolicyError(`${where}: unknown key "${key}"`);
  }
}

function strings(value: unknown, where: string, check: (s: string) => boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || !check(s))) {
    throw new PolicyError(`${where}: expected a list of valid names`);
  }
  return [...new Set(value as string[])];
}

export function parsePolicy(input: unknown): Policy {
  const root = obj(input, "policy");
  noExtraKeys(root, ["projects", "bins", "installDir", "upstreamPortMin", "publicIps"], "policy");

  const bins: Bins = { ...DEFAULT_BINS };
  if (root.bins !== undefined) {
    const given = obj(root.bins, "bins");
    noExtraKeys(given, [...BIN_NAMES], "bins");
    for (const [name, path] of Object.entries(given)) {
      if (typeof path !== "string" || !isAbsolutePath(path)) {
        throw new PolicyError(`bins.${name}: expected an absolute path`);
      }
      bins[name as BinName] = path;
    }
  }

  const installDir = root.installDir === undefined ? DEFAULT_INSTALL_DIR : root.installDir;
  if (typeof installDir !== "string" || !isAbsolutePath(installDir)) {
    throw new PolicyError("installDir: expected an absolute path");
  }
  const min = root.upstreamPortMin === undefined ? 1024 : root.upstreamPortMin;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1024 || min > 65535) {
    throw new PolicyError("upstreamPortMin: expected an integer between 1024 and 65535");
  }

  let publicIps: string[] | undefined;
  if (root.publicIps !== undefined) {
    if (
      !Array.isArray(root.publicIps) ||
      root.publicIps.some((ip) => typeof ip !== "string" || isIP(ip) !== 4)
    ) {
      throw new PolicyError("publicIps: expected a list of IPv4 addresses");
    }
    publicIps = [...new Set(root.publicIps as string[])].sort();
  }

  const projects: Record<string, ProjectPolicy> = {};
  for (const [id, raw] of Object.entries(obj(root.projects, "projects"))) {
    if (!PROJECT_ID.test(id)) throw new PolicyError(`projects.${id}: invalid project id`);
    const p = obj(raw, `projects.${id}`);
    noExtraKeys(
      p,
      ["domains", "www", "containers", "pm2", "nginx", "webroot", "compose"],
      `projects.${id}`,
    );
    const project: ProjectPolicy = {
      domains: strings(p.domains, `projects.${id}.domains`, isDomain),
      www: p.www === true,
      containers: strings(p.containers, `projects.${id}.containers`, isSafeName),
      pm2: strings(p.pm2, `projects.${id}.pm2`, isSafeName),
      nginx: p.nginx === true,
    };
    if (p.webroot !== undefined) {
      if (typeof p.webroot !== "string" || !isAbsolutePath(p.webroot)) {
        throw new PolicyError(`projects.${id}.webroot: expected an absolute path`);
      }
      project.webroot = p.webroot;
    }
    if (p.compose !== undefined) {
      const c = obj(p.compose, `projects.${id}.compose`);
      noExtraKeys(c, ["name", "file"], `projects.${id}.compose`);
      if (
        typeof c.name !== "string" ||
        !isSafeName(c.name) ||
        typeof c.file !== "string" ||
        !isAbsolutePath(c.file)
      ) {
        throw new PolicyError(`projects.${id}.compose: needs a safe name and an absolute file`);
      }
      project.compose = { name: c.name, file: c.file };
    }
    projects[id] = project;
  }
  return { projects, bins, installDir, upstreamPortMin: min, ...(publicIps ? { publicIps } : {}) };
}

/** Every domain the policy covers, including the www sibling where enabled. */
export function coveredDomains(project: ProjectPolicy): string[] {
  return project.domains.flatMap((d) => (project.www ? [d, `www.${d}`] : [d]));
}

export function allCoveredDomains(policy: Policy): string[] {
  return [...new Set(Object.values(policy.projects).flatMap(coveredDomains))];
}

export function allPm2Apps(policy: Policy): string[] {
  return [...new Set(Object.values(policy.projects).flatMap((p) => p.pm2))];
}

export function helperPath(policy: Policy): string {
  return `${policy.installDir}/src/nginx-site.ts`;
}
