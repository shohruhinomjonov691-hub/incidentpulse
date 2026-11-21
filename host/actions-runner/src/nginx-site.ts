/**
 * Privileged helper for the `nginx_site_proxy` runbook. It runs as root, ONLY through a sudoers
 * rule that names this exact script, the mode, a policy domain and a 127.0.0.1:<port> upstream:
 *
 *   node nginx-site.ts check <domain> 127.0.0.1:<port>   # validate, change nothing
 *   node nginx-site.ts apply <domain> 127.0.0.1:<port>   # backup, write vhost, nginx -t, reload, verify
 *
 * It re-validates everything itself (it must not trust the unprivileged caller), reads the root-owned
 * policy from a fixed path, and rolls back automatically when any step after the first write fails.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { parseNginxServers } from "./parse.ts";
import { type Policy, type ProjectPolicy, parsePolicy } from "./policy.ts";

export const POLICY_PATH = "/etc/incidentpulse/actions-policy.json";
export const BACKUP_DIR = "/var/backups/incidentpulse";
const SITES_AVAILABLE = "/etc/nginx/sites-available";
const SITES_ENABLED = "/etc/nginx/sites-enabled";
export const MANAGED_MARK = "# managed-by: incidentpulse nginx_site_proxy";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the helper touches, so tests can run it against a fake host. */
export interface SiteEnv {
  run(file: string, args: string[]): Promise<RunResult>;
  exists(path: string): boolean;
  write(path: string, content: string): void;
  symlink(target: string, path: string): void;
  remove(path: string): void;
  mkdirp(path: string): void;
  tcpOpen(port: number): Promise<boolean>;
  /** HTTP status of GET http://127.0.0.1/ with the given Host header, or undefined. */
  httpStatus(host: string): Promise<number | undefined>;
  now(): Date;
}

export interface SiteRequest {
  mode: "check" | "apply";
  domain: string;
  upstream: string;
}

export interface SiteResult {
  ok: boolean;
  output: string;
}

export function renderVhost(args: {
  domain: string;
  www: boolean;
  upstream: string;
  webroot: string;
}): string {
  const names = args.www ? `${args.domain} www.${args.domain}` : args.domain;
  return `${MANAGED_MARK}
# Remove with: rm ${SITES_ENABLED}/${args.domain}.conf ${SITES_AVAILABLE}/${args.domain}.conf && nginx -t && systemctl reload nginx
# Certificates are added later by certbot --nginx (runbook certbot_nginx_issue).
server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    location ^~ /.well-known/acme-challenge/ {
        root ${args.webroot};
        default_type "text/plain";
    }

    location / {
        proxy_pass http://${args.upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
`;
}

const UPSTREAM = /^127\.0\.0\.1:([1-9]\d{3,4})$/;
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
const tail = (text: string, n = 700) => (text.length > n ? `…${text.slice(-n)}` : text).trim();

function findProject(policy: Policy, domain: string): ProjectPolicy | undefined {
  return Object.values(policy.projects).find((p) => p.domains.includes(domain) && p.nginx);
}

export async function siteProxy(
  env: SiteEnv,
  policy: Policy,
  req: SiteRequest,
): Promise<SiteResult> {
  const out: string[] = [];
  const fail = (message: string): SiteResult => ({
    ok: false,
    output: [...out, message].join("\n"),
  });
  const nginx = (args: string[]) => env.run(policy.bins.nginx, args);

  const project = findProject(policy, req.domain);
  if (!project?.webroot) return fail("Domain is not enabled for nginx_site_proxy in the policy");
  const port = Number(UPSTREAM.exec(req.upstream)?.[1]);
  if (!Number.isInteger(port) || port < policy.upstreamPortMin || port > 65535) {
    return fail("Upstream must be 127.0.0.1:<port> within the allowed port range");
  }
  if (!(await env.tcpOpen(port))) return fail(`Nothing is listening on ${req.upstream}`);

  const names = project.www ? [req.domain, `www.${req.domain}`] : [req.domain];
  const before = await nginx(["-T"]);
  if (before.code !== 0) return fail(`nginx -T failed before any change: ${tail(before.stderr)}`);
  const taken = parseNginxServers(before.stdout).filter((s) =>
    s.names.some((n) => names.includes(n)),
  );
  if (taken.length > 0) return fail("An nginx server block for this domain already exists");

  const available = `${SITES_AVAILABLE}/${req.domain}.conf`;
  const enabled = `${SITES_ENABLED}/${req.domain}.conf`;
  if (env.exists(available) || env.exists(enabled)) {
    return fail(`${req.domain}.conf already exists in sites-available or sites-enabled`);
  }
  const content = renderVhost({
    domain: req.domain,
    www: project.www,
    upstream: req.upstream,
    webroot: project.webroot,
  });

  if (req.mode === "check") {
    return {
      ok: true,
      output: `would create ${enabled} -> ${req.upstream} for ${names.join(", ")}; nginx -T is valid`,
    };
  }

  // 1. Backup /etc/nginx. Without it nothing is changed.
  const backup = `${BACKUP_DIR}/nginx-${stamp(env.now())}.tar.gz`;
  env.mkdirp(BACKUP_DIR);
  const saved = await env.run(policy.bins.tar, ["-czf", backup, "-C", "/etc", "nginx"]);
  if (saved.code !== 0)
    return fail(`Backup of /etc/nginx failed, nothing changed: ${tail(saved.stderr)}`);
  out.push(`backup=${backup}`);

  const rollback = async (reason: string): Promise<SiteResult> => {
    for (const path of [enabled, available]) {
      try {
        env.remove(path);
      } catch {
        // already gone
      }
    }
    let verified = await nginx(["-t"]);
    if (verified.code !== 0) {
      await env.run(policy.bins.tar, ["-xzf", backup, "-C", "/etc"]);
      verified = await nginx(["-t"]);
      out.push("config restored from backup");
    }
    const reload =
      verified.code === 0 ? await env.run(policy.bins.systemctl, ["reload", "nginx"]) : undefined;
    out.push(
      `ROLLED BACK (${reason}); nginx -t after rollback: ${verified.code === 0 ? "ok" : `FAILED ${tail(verified.stderr)}`}${
        reload && reload.code !== 0 ? "; reload failed" : ""
      }`,
    );
    return { ok: false, output: out.join("\n") };
  };

  // 2. Write the vhost (0644) and enable it.
  try {
    env.write(available, content);
    env.symlink(available, enabled);
  } catch (error) {
    return rollback(`write failed: ${(error as Error).message}`);
  }

  // 3. Test, 4. reload, 5. verify the new server block answers.
  const test = await nginx(["-t"]);
  if (test.code !== 0) return rollback(`nginx -t failed: ${tail(test.stderr)}`);
  const reload = await env.run(policy.bins.systemctl, ["reload", "nginx"]);
  if (reload.code !== 0) return rollback(`reload failed: ${tail(reload.stderr)}`);
  const after = await nginx(["-T"]);
  const live = parseNginxServers(after.stdout).some((s) => s.names.includes(req.domain));
  if (!live) return rollback("the new server block is not part of the active configuration");
  const status = await env.httpStatus(req.domain);
  if (status === undefined || status >= 500) {
    return rollback(`HTTP check through nginx returned ${status ?? "no response"}`);
  }
  out.push(`vhost=${enabled} upstream=${req.upstream} http_status=${status}`);
  return { ok: true, output: out.join("\n") };
}

// ------------------------------------------------------------------------ real host

export function realEnv(): SiteEnv {
  return {
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(
          file,
          args,
          {
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8",
            shell: false,
            env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C.UTF-8" },
          },
          (error, stdout, stderr) =>
            resolve({
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout: stdout ?? "",
              stderr: `${stderr ?? ""}${error && typeof error.code !== "number" ? error.message : ""}`,
            }),
        );
      }),
    exists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    write: (path, content) => {
      writeFileSync(path, content, { flag: "wx", mode: 0o644 });
      chmodSync(path, 0o644);
    },
    symlink: (target, path) => symlinkSync(target, path),
    remove: (path) => unlinkSync(path),
    mkdirp: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    },
    tcpOpen: (port) =>
      new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.setTimeout(2000);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(false));
      }),
    httpStatus: (host) =>
      new Promise((resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: 80,
            path: "/",
            method: "GET",
            headers: { host },
            timeout: 8000,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.once("timeout", () => {
          req.destroy();
          resolve(undefined);
        });
        req.once("error", () => resolve(undefined));
        req.end();
      }),
    now: () => new Date(),
  };
}

/** The policy is read with root's authority, so it must itself be root-owned and not group/world-writable. */
export function loadRootPolicy(path = POLICY_PATH): Policy {
  const info = statSync(path);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error(`${path} must be owned by root and not writable by group or others`);
  }
  return parsePolicy(JSON.parse(readFileSync(path, "utf8")));
}

async function main() {
  const [mode, domain, upstream] = process.argv.slice(2);
  if ((mode !== "check" && mode !== "apply") || !domain || !upstream || process.argv.length !== 5) {
    console.error("usage: nginx-site.ts <check|apply> <domain> <127.0.0.1:port>");
    process.exit(2);
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("nginx-site.ts must run as root (through its sudoers rule)");
    process.exit(2);
  }
  if (!existsSync(POLICY_PATH)) {
    console.error(`missing ${POLICY_PATH}`);
    process.exit(2);
  }
  const result = await siteProxy(realEnv(), loadRootPolicy(), { mode, domain, upstream });
  console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`nginx-site.ts failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
