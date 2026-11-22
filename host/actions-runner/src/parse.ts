/** Pure parsers for host command output. Nothing here runs a process. */

// ------------------------------------------------------------------ scrubbing

const SCRUB: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  [
    /\b((?:[A-Za-z0-9_-]*?)(?:api[_-]?key|secret|token|passwd|password|authorization)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    "$1[REDACTED]",
  ],
];

/** Last-resort masking of command output. The orchestrator redacts again; this is defence in depth. */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out;
}

// ------------------------------------------------------------------------ pm2

export interface Pm2App {
  name: string;
  pid: number | undefined;
  status: string;
  restarts: number;
  /** Epoch milliseconds of the last (re)start, when the app is online. */
  since: number | undefined;
}

/** `pm2 jlist` rows reduced to the allowlisted apps. pm2 may print a banner before the JSON. */
export function parsePm2Jlist(stdout: string, allowed: readonly string[]): Pm2App[] {
  const start = stdout.search(/^\[\s*(?:\{|\])/m);
  if (start < 0) throw new Error("BAD_OUTPUT");
  const rows = JSON.parse(stdout.slice(start)) as Array<{
    name?: unknown;
    pid?: unknown;
    pm2_env?: { status?: unknown; restart_time?: unknown; pm_uptime?: unknown };
  }>;
  return rows
    .filter((r) => typeof r.name === "string" && allowed.includes(r.name))
    .map((r) => ({
      name: r.name as string,
      pid: typeof r.pid === "number" && r.pid > 0 ? r.pid : undefined,
      status: typeof r.pm2_env?.status === "string" ? r.pm2_env.status : "unknown",
      restarts: Math.max(0, Math.floor(Number(r.pm2_env?.restart_time ?? 0)) || 0),
      since: typeof r.pm2_env?.pm_uptime === "number" ? r.pm2_env.pm_uptime : undefined,
    }));
}

const MAX_LOG_LINE = 400;

/**
 * The last `lines` lines of `pm2 logs --nostream`, without pm2's own headers. The WHOLE text is scrubbed
 * before it is split into lines and before any line is cut: a long secret or a multi-line private key must
 * match its full pattern, and a cut can never leave a fragment of one behind.
 */
export function parsePm2Logs(output: string, lines: number): string[] {
  return scrub(output)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0 && !/^\[TAILING\]/.test(l))
    .slice(-lines)
    .map((l) => (l.length > MAX_LOG_LINE ? `${l.slice(0, MAX_LOG_LINE)}…` : l));
}

// ---------------------------------------------------------------------- ports

export interface Listener {
  address: string;
  port: number;
  pids: number[];
}

/** `ss -H -ltnp`: "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:((\"node\",pid=12,fd=20))". */
export function parseSs(stdout: string): Listener[] {
  const out: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || cols.length < 5) continue;
    const local = cols[3] ?? "";
    const cut = local.lastIndexOf(":");
    const port = Number(local.slice(cut + 1));
    if (cut < 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    out.push({ address: local.slice(0, cut).replace(/%.*$/, ""), port, pids });
  }
  return out;
}

/** True for sockets another process on this host reaches through 127.0.0.1. */
export function reachableViaLoopback(address: string): boolean {
  return ["0.0.0.0", "127.0.0.1", "*", "[::]", "::"].includes(address);
}

/** `ps -eo pid=,ppid=` -> parent pid to children. */
export function parsePsTree(stdout: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const parent = Number(m[2]);
    children.set(parent, [...(children.get(parent) ?? []), Number(m[1])]);
  }
  return children;
}

export function descendants(pid: number, tree: Map<number, number[]>, limit = 500): Set<number> {
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0 && seen.size < limit) {
    for (const child of tree.get(queue.shift() as number) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

export interface AppPorts {
  app: string;
  pid: number | undefined;
  ports: number[];
}

/** Loopback-reachable listening ports owned by each pm2 app or by one of its descendants. */
export function portsPerApp(
  apps: readonly Pm2App[],
  listeners: readonly Listener[],
  tree: Map<number, number[]>,
): AppPorts[] {
  return apps.map((app) => {
    const owned =
      app.pid === undefined || app.status !== "online"
        ? new Set<number>()
        : descendants(app.pid, tree);
    const ports = listeners
      .filter((l) => reachableViaLoopback(l.address) && l.pids.some((pid) => owned.has(pid)))
      .map((l) => l.port);
    return { app: app.name, pid: app.pid, ports: [...new Set(ports)].sort((a, b) => a - b) };
  });
}

// ---------------------------------------------------------------------- nginx

export interface NginxServer {
  names: string[];
  listens: string[];
  ssl: boolean;
  proxyPass: string[];
  defaultServer: boolean;
}

/**
 * Server blocks of an `nginx -T` dump. A small tokenizer, not a full nginx parser: it understands
 * braces, `;`, comments and quoted strings, which is enough for listen/server_name/proxy_pass.
 */
export function parseNginxServers(dump: string): NginxServer[] {
  const text = dump
    .split("\n")
    .filter((line) => !/^\s*nginx:/.test(line))
    .join("\n")
    .replace(/#[^\n]*/g, "");
  const tokens = text.match(/"[^"]*"|'[^']*'|[{};]|[^\s{};]+/g) ?? [];
  const servers: NginxServer[] = [];
  const stack: Array<{ server: NginxServer | undefined }> = [];
  let current: string[] = [];

  const directive = () => {
    const server = stack.at(-1)?.server;
    if (!server) return;
    const [name, ...args] = current;
    if (name === "listen" && args[0]) {
      server.listens.push(args[0]);
      if (args.includes("ssl")) server.ssl = true;
      if (args.includes("default_server")) server.defaultServer = true;
    } else if (name === "server_name") {
      server.names.push(...args.map((a) => a.replace(/^["']|["']$/g, "").toLowerCase()));
    } else if (name === "ssl_certificate") {
      server.ssl = true;
    } else if (name === "proxy_pass" && args[0]) {
      server.proxyPass.push(args[0]);
    }
  };

  for (const token of tokens) {
    if (token === "{") {
      const parent = stack.at(-1)?.server;
      if (current.length === 1 && current[0] === "server") {
        const server: NginxServer = {
          names: [],
          listens: [],
          ssl: false,
          proxyPass: [],
          defaultServer: false,
        };
        servers.push(server);
        stack.push({ server });
      } else {
        stack.push({ server: parent });
      }
      current = [];
    } else if (token === "}") {
      stack.pop();
      current = [];
    } else if (token === ";") {
      directive();
      current = [];
    } else {
      current.push(token);
    }
  }
  return servers;
}

// -------------------------------------------------------------------- certbot

export interface CertificateInfo {
  name: string;
  domains: string[];
  expiresAt: string | undefined;
  daysRemaining: number | undefined;
  valid: boolean;
}

/** `certbot certificates` blocks. Key and certificate paths are intentionally dropped. */
export function parseCertbotCertificates(stdout: string): CertificateInfo[] {
  const certs: CertificateInfo[] = [];
  for (const block of stdout.split(/^\s*Certificate Name:\s*/m).slice(1)) {
    const name = block.split("\n")[0]?.trim() ?? "";
    const domains = (/^\s*Domains:\s*(.+)$/m.exec(block)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((d) => d.toLowerCase());
    const expiry = /^\s*Expiry Date:\s*(\S+ \S+)\s*\(([^)]*)\)/m.exec(block);
    const date = expiry?.[1] ? new Date(expiry[1].replace(" ", "T")) : undefined;
    const valid = /^VALID/.test(expiry?.[2]?.trim() ?? "");
    const days = /(-?\d+)\s+days?/.exec(expiry?.[2] ?? "")?.[1];
    certs.push({
      name,
      domains,
      expiresAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined,
      daysRemaining: days === undefined ? undefined : Number(days),
      valid,
    });
  }
  return certs.filter((c) => c.name && c.domains.length > 0);
}
