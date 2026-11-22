import { resolve4 as dnsResolve4 } from "node:dns/promises";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { Denied, READ_STEPS, type ResolvedRunbook, resolveRunbook } from "./commands.ts";
import { type Exec, runStep, type Step } from "./exec.ts";
import {
  parseCertbotCertificates,
  parseNginxServers,
  parsePm2Jlist,
  parsePm2Logs,
  parsePsTree,
  parseSs,
  portsPerApp,
  scrub,
} from "./parse.ts";
import { buildPlan } from "./plan.ts";
import {
  allCoveredDomains,
  allPm2Apps,
  coveredDomains,
  isSafeName,
  type Policy,
  type ProjectPolicy,
} from "./policy.ts";
import { checkApprovalToken, type Ledger, type TokenClaims } from "./token.ts";

export interface RunnerDeps {
  policy: Policy;
  exec: Exec;
  /** APPROVAL_HMAC_SECRET */
  secret: string;
  ledger: Ledger;
  now(): number;
  /** HTTP status of GET http://127.0.0.1:<port>/, undefined when nothing answers. */
  probeLocal(port: number): Promise<number | undefined>;
  log(event: Record<string, unknown>): void;
  /** A records of a host name; an empty list when it does not resolve. Default: node:dns. */
  resolve4?(host: string): Promise<string[]>;
  /** This server's public IPv4 addresses. Default: policy.publicIps, else the non-internal interface addresses. */
  serverAddresses?(): string[];
  /** Independent pause switch (POST /v1/pause, /v1/resume). Default: in memory. */
  pause?: PauseState;
}

/** The runner's own kill switch: state-changing runbooks are refused (queued ones too) while it is on. */
export interface PauseState {
  isPaused(): boolean;
  set(paused: boolean): void;
}

export const memoryPause = (initial = false): PauseState => {
  let paused = initial;
  return {
    isPaused: () => paused,
    set: (value) => {
      paused = value;
    },
  };
};

/** Persisted as the existence of a file, so a restart of the runner does not silently un-pause it. */
export function filePause(path: string): PauseState {
  return {
    isPaused: () => existsSync(path),
    set(paused) {
      if (paused) writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
      else if (existsSync(path)) unlinkSync(path);
    },
  };
}

/** At most this many jobs wait behind the running one; the next request gets 429 and nothing is queued. */
export const MAX_WAITING_JOBS = 4;

const RUNNER_ERROR_CODES = new Set(["BAD_OUTPUT", "PM2_FAILED", "SS_FAILED"]);

/** Codes only, never `error.message` (it can carry command output or paths). */
export function errorCode(error: unknown): string {
  if (error instanceof Denied) return "DENIED";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  if (error instanceof Error) {
    return RUNNER_ERROR_CODES.has(error.message) ? error.message : "Error";
  }
  return "UNKNOWN";
}

interface JobInfo {
  kind: "dry-run" | "execute";
  project: string;
  runbookId: string;
  approvalId?: string;
  queuedAt: number;
}

const interfaceAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && a.family === "IPv4" && !a.internal)
    .map((a) => (a as { address: string }).address);

export interface RunnerResponse {
  status: number;
  body: Record<string, unknown>;
}

// Keep complete output for the orchestrator's common redactor, within the socket client's 1 MiB JSON limit.
const MAX_OUTPUT_BYTES = 128 * 1024;
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const bad = (status: number, error: string): RunnerResponse => ({
  status,
  body: { ok: false, error },
});

export function createRunner(deps: RunnerDeps) {
  const { policy, exec } = deps;
  const covered = new Set(allCoveredDomains(policy));
  const pm2Apps = allPm2Apps(policy);

  const pause = deps.pause ?? memoryPause();
  const resolve4 = deps.resolve4 ?? (async (host: string) => dnsResolve4(host).catch(() => []));
  const serverAddresses = deps.serverAddresses ?? (() => policy.publicIps ?? interfaceAddresses());

  // Mutating work and dry-runs are serialized: one certbot/nginx/pm2 operation at a time. At most
  // MAX_WAITING_JOBS wait behind the running one; more are refused (429) instead of piling up.
  let tail: Promise<unknown> = Promise.resolve();
  const waiting: JobInfo[] = [];
  let running: JobInfo | undefined;
  const enqueue = (info: JobInfo, work: () => Promise<RunnerResponse>): Promise<RunnerResponse> => {
    if (waiting.length >= MAX_WAITING_JOBS) {
      if (info.approvalId) deps.ledger.refuse(info.approvalId, "queue_full", deps.now());
      deps.log({
        event: "refused",
        reason: "queue_full",
        kind: info.kind,
        project: info.project,
        runbookId: info.runbookId,
        ...(info.approvalId ? { approvalId: info.approvalId } : {}),
      });
      return Promise.resolve(bad(429, "Runner queue is full; try again later"));
    }
    waiting.push(info);
    const start = async () => {
      waiting.splice(waiting.indexOf(info), 1);
      running = info;
      try {
        return await work();
      } finally {
        running = undefined;
      }
    };
    const next = tail.then(start, start);
    tail = next.catch(() => undefined);
    return next;
  };
  const describeJob = (job: JobInfo) => ({
    kind: job.kind,
    project: job.project,
    runbookId: job.runbookId,
    ...(job.approvalId ? { approvalId: job.approvalId } : {}),
    sinceMs: Math.max(0, deps.now() - job.queuedAt),
  });
  const status = (): RunnerResponse => ({
    status: 200,
    body: {
      ok: true,
      paused: pause.isPaused(),
      running: running ? [describeJob(running)] : [],
      queued: waiting.map(describeJob),
    },
  });
  let reading = 0;

  const run = (step: Step) => runStep(policy, exec, step);

  // ---------------------------------------------------------------- read-only ops

  async function jlist() {
    const r = await run(READ_STEPS.pm2Jlist);
    if (r.code !== 0 && !r.stdout) throw new Error("PM2_FAILED");
    return parsePm2Jlist(r.stdout, pm2Apps);
  }

  async function portsOf(apps: readonly string[]) {
    const [list, listeners, tree] = await Promise.all([
      jlist(),
      run(READ_STEPS.listeners),
      run(READ_STEPS.processTree),
    ]);
    if (listeners.code !== 0) throw new Error("SS_FAILED");
    return portsPerApp(
      list.filter((a) => apps.includes(a.name)),
      parseSs(listeners.stdout),
      parsePsTree(tree.stdout),
    );
  }

  async function readOp(op: string, args: Record<string, unknown>): Promise<RunnerResponse> {
    switch (op) {
      case "pm2_jlist": {
        const apps = await jlist();
        return {
          status: 200,
          body: {
            ok: true,
            apps: apps.map(({ name, pid, status, restarts, since }) => ({
              name,
              ...(pid === undefined ? {} : { pid }),
              status,
              restarts,
              ...(since === undefined ? {} : { since }),
            })),
          },
        };
      }
      case "pm2_logs": {
        const app = args.app;
        if (typeof app !== "string" || !isSafeName(app) || !pm2Apps.includes(app)) {
          return bad(403, "pm2 app is not in the policy");
        }
        const lines = Math.min(200, Math.max(1, Math.floor(Number(args.lines ?? 100)) || 100));
        const r = await run(READ_STEPS.pm2Logs(app));
        if (r.code !== 0 && !r.stdout) throw new Error("PM2_FAILED");
        return { status: 200, body: { ok: true, app, lines: parsePm2Logs(r.stdout, lines) } };
      }
      case "pm2_ports": {
        const wanted = Array.isArray(args.apps)
          ? (args.apps as unknown[]).filter((a): a is string => typeof a === "string")
          : pm2Apps;
        const apps = wanted.filter((a) => pm2Apps.includes(a));
        return { status: 200, body: { ok: true, apps: await portsOf(apps) } };
      }
      case "nginx_config": {
        const r = await run(READ_STEPS.nginxDump);
        if (r.code !== 0) return { status: 200, body: { ok: false, error: "NGINX_FAILED" } };
        const servers = parseNginxServers(r.stdout)
          .filter((s) => s.names.some((n) => covered.has(n)))
          .map((s) => ({
            names: s.names.filter((n) => covered.has(n)),
            listens: s.listens.slice(0, 6),
            ssl: s.ssl,
            proxyPass: s.proxyPass.slice(0, 4),
          }));
        return { status: 200, body: { ok: true, servers } };
      }
      case "cert_list": {
        const r = await run(READ_STEPS.certificates);
        if (r.code !== 0) return { status: 200, body: { ok: false, error: "CERTBOT_FAILED" } };
        const certificates = parseCertbotCertificates(r.stdout)
          .filter((c) => c.domains.some((d) => covered.has(d)))
          .map((c) => ({ ...c, domains: c.domains.filter((d) => covered.has(d)) }));
        return { status: 200, body: { ok: true, certificates } };
      }
      default:
        return bad(400, "Unknown read operation");
    }
  }

  // -------------------------------------------------------------------- runbooks

  /** nginx_site_proxy: the port must belong to one of THIS project's pm2 apps and answer HTTP. */
  async function verifyUpstream(
    project: ProjectPolicy,
    book: ResolvedRunbook,
  ): Promise<string | undefined> {
    if (!book.upstream) return undefined;
    const owned = (await portsOf(project.pm2)).flatMap((a) => a.ports);
    if (!owned.includes(book.upstream.port)) {
      return `Port ${book.upstream.port} is not a listening port of this project's pm2 apps (${project.pm2.join(", ")})`;
    }
    const status = await deps.probeLocal(book.upstream.port);
    if (status === undefined || status >= 500) {
      return `Upstream 127.0.0.1:${book.upstream.port} did not answer healthily (status ${status ?? "none"})`;
    }
    return undefined;
  }

  /**
   * nginx_site_proxy creates a NEW server block, so it is refused outright when `nginx -T` (every included
   * file, not only sites-enabled) already has a server_name for the domain. The root helper repeats this.
   */
  async function checkNoVhostYet(
    project: ProjectPolicy,
    domain: string,
  ): Promise<string | undefined> {
    const names = coveredDomains({ ...project, domains: [domain] });
    const dump = await run(READ_STEPS.nginxDump);
    if (dump.code !== 0) return "Could not read the nginx configuration (nginx -T)";
    const served = new Set(parseNginxServers(dump.stdout).flatMap((s) => s.names));
    const taken = names.filter((n) => served.has(n));
    return taken.length > 0
      ? `nginx already has a server block for ${taken.join(", ")}; nginx_site_proxy only creates a missing one`
      : undefined;
  }

  /** Does every name of the domain resolve (A) to one of THIS server's addresses? */
  async function checkDnsPointsHere(names: string[]): Promise<string | undefined> {
    const here = new Set(serverAddresses());
    if (here.size === 0)
      return "This server's public IPv4 address is unknown; set publicIps in the policy";
    for (const name of names) {
      const records = await resolve4(name);
      if (records.length === 0 || records.some((ip) => !here.has(ip))) {
        return `DNS A record of ${name} (${records.join(", ") || "none"}) does not point at this server (${[...here].join(", ")})`;
      }
    }
    return undefined;
  }

  /**
   * certbot_nginx_issue, STATIC checks only (nothing here touches the live nginx): the vhost exists, DNS A
   * points at this server, and the certificate is missing or stale (not valid / expired).
   */
  async function checkIssuePrerequisite(
    project: ProjectPolicy,
    domain: string,
  ): Promise<string | undefined> {
    const names = coveredDomains({ ...project, domains: [domain] });
    const [certs, dump] = await Promise.all([
      run(READ_STEPS.certificates),
      run(READ_STEPS.nginxDump),
    ]);
    if (certs.code !== 0 || dump.code !== 0) return "Could not read certbot or nginx inventory";
    const current = new Set(
      parseCertbotCertificates(certs.stdout)
        .filter((c) => c.valid && (c.daysRemaining ?? 1) > 0)
        .flatMap((c) => c.domains),
    );
    const served = new Set(parseNginxServers(dump.stdout).flatMap((s) => s.names));
    const missingVhost = names.filter((n) => !served.has(n));
    if (missingVhost.length === names.length) {
      return `No nginx server block for ${missingVhost.join(", ")}; create the vhost first (nginx_site_proxy)`;
    }
    if (missingVhost.length > 0) {
      return `nginx already has a server block for this domain but none names ${missingVhost.join(", ")}; add it to server_name by hand (nginx_site_proxy never touches an existing block) or drop "www" from the policy and scope`;
    }
    const dns = await checkDnsPointsHere(names);
    if (dns) return dns;
    if (names.every((n) => current.has(n))) {
      return "Valid certificates for these names already exist; use certbot_renew";
    }
    return undefined;
  }

  /** certbot_renew, STATIC check: `certbot renew --cert-name <domain>` needs that certificate to exist. */
  async function checkRenewPrerequisite(domain: string): Promise<string | undefined> {
    const certs = await run(READ_STEPS.certificates);
    if (certs.code !== 0) return "Could not read the certbot inventory";
    return parseCertbotCertificates(certs.stdout).some((c) => c.name === domain)
      ? undefined
      : `No certificate named ${domain}; use certbot_nginx_issue`;
  }

  /**
   * Runs the steps in order and stops at the first failure. `gate(index)` is asked before every step (pause
   * between steps; expiry before the first): a refusal stops the run there and says how far it got.
   */
  async function steps(
    list: Step[],
    gate?: (index: number) => string | undefined,
  ): Promise<{ ok: boolean; output: string; failedStep?: number }> {
    const output: string[] = [];
    const finish = (ok: boolean, failedStep?: number) => {
      const text = scrub(output.join("\n"));
      return {
        ok,
        output:
          Buffer.byteLength(text) > MAX_OUTPUT_BYTES
            ? "Runner output omitted: size limit exceeded"
            : text || (ok ? "OK" : "Failed"),
        ...(failedStep === undefined ? {} : { failedStep }),
      };
    };
    for (const [index, step] of list.entries()) {
      const refusal = gate?.(index);
      if (refusal) {
        output.push(`stopped before step ${index + 1} of ${list.length}: ${refusal}`);
        return finish(false, index);
      }
      const r = await run(step);
      output.push(`$ ${step.bin} ${step.args.join(" ")}`);
      const text = `${r.stdout}\n${r.stderr}`.trim();
      if (text) output.push(text);
      if (r.code !== 0) {
        output.push(`exit status ${r.code}`);
        return finish(false, index);
      }
    }
    return finish(true);
  }

  function parseRunbook(body: Record<string, unknown>) {
    const params = asRecord(body.params);
    if (
      typeof body.project !== "string" ||
      typeof body.runbookId !== "string" ||
      !params ||
      Object.values(params).some((v) => typeof v !== "string")
    ) {
      throw new Denied("project, runbookId and params are required");
    }
    const book = resolveRunbook(
      policy,
      body.project,
      body.runbookId,
      params as Record<string, string>,
    );
    return {
      project: policy.projects[body.project] as ProjectPolicy,
      book,
      params: params as Record<string, string>,
    };
  }

  async function guarded(
    project: ProjectPolicy,
    book: ResolvedRunbook,
  ): Promise<string | undefined> {
    if (book.runbookId === "nginx_site_proxy" && book.domain) {
      const taken = await checkNoVhostYet(project, book.domain);
      if (taken) return taken;
    }
    const upstream = await verifyUpstream(project, book);
    if (upstream) return upstream;
    if (book.prerequisite === "vhost_dns_certificate_missing_or_stale" && book.domain) {
      return checkIssuePrerequisite(project, book.domain);
    }
    if (book.prerequisite === "certificate_present" && book.domain) {
      return checkRenewPrerequisite(book.domain);
    }
    return undefined;
  }

  /** The canonical plan (digest, policy digest, human summary) for a request. Read-only, runs no command. */
  function plan(body: Record<string, unknown>): RunnerResponse {
    const { book, params } = parseRunbook(body);
    return {
      status: 200,
      body: { ok: true, ...buildPlan(policy, String(body.project), book, params) },
    };
  }

  /** Pre-approval check: static inventory/config checks and `nginx -t` only. Never touches the live nginx. */
  async function dryRun(body: Record<string, unknown>): Promise<RunnerResponse> {
    const { project, book } = parseRunbook(body);
    const info: JobInfo = {
      kind: "dry-run",
      project: String(body.project),
      runbookId: book.runbookId,
      queuedAt: deps.now(),
    };
    return enqueue(info, async () => {
      const refusal = await guarded(project, book);
      if (refusal) return { status: 200, body: { ok: false, output: refusal } };
      const result = await steps(book.dryRun);
      return { status: 200, body: { ...result } };
    });
  }

  async function execute(body: Record<string, unknown>): Promise<RunnerResponse> {
    const { project, book, params } = parseRunbook(body);
    const claims: TokenClaims = {
      approvalId: String(body.approvalId ?? ""),
      incidentId: String(body.incidentId ?? ""),
      project: String(body.project),
      runbookId: book.runbookId,
      params,
      planDigest: String(body.planDigest ?? ""),
      tokenExpiresAt: Number(body.tokenExpiresAt),
    };
    if (
      !/^[A-Za-z0-9_-]{16}$/.test(claims.approvalId) ||
      !claims.incidentId ||
      claims.incidentId.length > 150 ||
      !/^[0-9a-f]{64}$/.test(claims.planDigest)
    ) {
      return bad(400, "approvalId, incidentId and planDigest are required");
    }
    const token = typeof body.approvalToken === "string" ? body.approvalToken : "";
    const refusal = checkApprovalToken(deps.secret, claims, token, deps.now());
    if (refusal) {
      deps.log({ event: "refused", approvalId: claims.approvalId, reason: refusal });
      return bad(403, refusal);
    }
    // The plan is recomputed from THIS host's policy: a changed parameter or policy needs a new approval.
    const current = buildPlan(policy, claims.project, book, params);
    if (current.planDigest !== claims.planDigest) {
      deps.log({ event: "refused", approvalId: claims.approvalId, reason: "plan_mismatch" });
      return bad(
        403,
        "Plan digest mismatch: the parameters or the host policy changed since approval; a new approval is required",
      );
    }
    const info: JobInfo = {
      kind: "execute",
      project: claims.project,
      runbookId: claims.runbookId,
      approvalId: claims.approvalId,
      queuedAt: deps.now(),
    };
    return enqueue(info, async () => {
      // The job may have waited behind a long certbot run: pause and expiry are checked again at pickup.
      if (pause.isPaused()) {
        deps.ledger.refuse(claims.approvalId, "paused", deps.now());
        deps.log({ event: "refused", approvalId: claims.approvalId, reason: "paused" });
        return {
          status: 423,
          body: { ok: false, error: "paused", output: "The runner is paused; nothing was run" },
        };
      }
      const late = checkApprovalToken(deps.secret, claims, token, deps.now());
      if (late) {
        deps.ledger.refuse(claims.approvalId, "expired_in_queue", deps.now());
        deps.log({ event: "refused", approvalId: claims.approvalId, reason: "expired_in_queue" });
        return {
          status: 403,
          body: {
            ok: false,
            error: late,
            output: `${late} (after waiting in the queue); nothing was run`,
          },
        };
      }
      // Consumed before anything runs: a crash or a retry can never execute the approval twice.
      if (!deps.ledger.claim(claims.approvalId, deps.now())) {
        deps.log({ event: "replay_refused", approvalId: claims.approvalId });
        return {
          status: 409,
          body: { ok: false, output: "Approval was already consumed", error: "replay" },
        };
      }
      deps.log({
        event: "executing",
        approvalId: claims.approvalId,
        incidentId: claims.incidentId,
        project: claims.project,
        runbookId: claims.runbookId,
        planDigest: claims.planDigest,
        params,
      });
      let result: { ok: boolean; output: string; failedStep?: number };
      try {
        const refused = await guarded(project, book);
        result = refused
          ? { ok: false, output: refused, failedStep: 0 }
          : await steps(book.run, (index) => {
              const expired =
                index === (book.firstMutationStep ?? 0) &&
                checkApprovalToken(deps.secret, claims, token, deps.now());
              const reason = pause.isPaused()
                ? "paused"
                : expired
                  ? "expired_before_mutation"
                  : undefined;
              if (reason) {
                deps.ledger.refuse(claims.approvalId, reason, deps.now());
                deps.log({ event: "refused", approvalId: claims.approvalId, reason, step: index });
                return reason === "paused"
                  ? "the runner was paused"
                  : "the approval token expired before the first mutating step";
              }
              return undefined;
            });
      } catch (error) {
        const code = errorCode(error);
        deps.log({ event: "error", code });
        result = { ok: false, output: `Runner error: ${code}` };
      }
      deps.ledger.complete(claims.approvalId, result.ok, deps.now(), result.failedStep);
      // A failed step stops the run here (no later step), and the failing step is part of the audit record.
      deps.log({
        event: "finished",
        approvalId: claims.approvalId,
        ok: result.ok,
        ...(result.failedStep === undefined ? {} : { failedStep: result.failedStep }),
      });
      return { status: 200, body: { ok: result.ok, output: result.output } };
    });
  }

  // ----------------------------------------------------------------------- router

  async function handle(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<RunnerResponse> {
    try {
      if (method === "GET" && path === "/v1/health") {
        return { status: 200, body: { ok: true, projects: Object.keys(policy.projects).length } };
      }
      if (method === "GET" && path === "/v1/status") return status();
      if (method !== "POST") return bad(404, "Not found");
      if (path === "/v1/read") {
        if (reading >= 4) return bad(429, "Too many concurrent reads");
        reading += 1;
        try {
          return await readOp(String(body.op ?? ""), asRecord(body.args) ?? {});
        } finally {
          reading -= 1;
        }
      }
      if (path === "/v1/pause" || path === "/v1/resume") {
        pause.set(path === "/v1/pause");
        deps.log({ event: path === "/v1/pause" ? "paused" : "resumed" });
        return status();
      }
      if (path === "/v1/runbooks/plan") return plan(body);
      if (path === "/v1/runbooks/dry-run") return await dryRun(body);
      if (path === "/v1/runbooks/execute") return await execute(body);
      return bad(404, "Not found");
    } catch (error) {
      if (error instanceof Denied) return bad(403, error.message);
      deps.log({ event: "error", code: errorCode(error) });
      return bad(500, "Runner failed");
    }
  }

  return { handle };
}

// ------------------------------------------------------------------- HTTP glue

const MAX_BODY = 16_384;

export function createHttpServer(runner: ReturnType<typeof createRunner>): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const reply = ({ status, body }: RunnerResponse) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY && !rejected) {
        rejected = true;
        reply(bad(413, "Body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      let body: Record<string, unknown> = {};
      if (chunks.length > 0) {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const record = asRecord(parsed);
          if (!record) return reply(bad(400, "A JSON object is required"));
          body = record;
        } catch {
          return reply(bad(400, "Invalid JSON"));
        }
      }
      const path = (req.url ?? "").split("?")[0] ?? "";
      runner
        .handle(req.method ?? "", path, body)
        .then(reply, () => reply(bad(500, "Runner failed")));
    });
  });
  // certbot can take minutes; nothing else is slow.
  server.requestTimeout = 600_000;
  server.headersTimeout = 10_000;
  return server;
}

/** GET http://127.0.0.1:<port>/ : only the status code is read. */
export function probeLocalPort(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 5000 },
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
  });
}
