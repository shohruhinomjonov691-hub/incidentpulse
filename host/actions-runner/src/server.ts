import { createServer, request as httpRequest, type Server } from "node:http";
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
}

export interface RunnerResponse {
  status: number;
  body: Record<string, unknown>;
}

const OUTPUT_CAP = 4000;
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

  // Mutating work and dry-runs are serialized: one certbot/nginx/pm2 operation at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
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

  /** certbot_nginx_issue: a vhost must exist for every name and a certificate must be missing. */
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
    const certified = new Set(parseCertbotCertificates(certs.stdout).flatMap((c) => c.domains));
    const served = new Set(parseNginxServers(dump.stdout).flatMap((s) => s.names));
    const missingVhost = names.filter((n) => !served.has(n));
    if (missingVhost.length > 0) {
      return `No nginx server block for ${missingVhost.join(", ")}; create the vhost first (nginx_site_proxy)`;
    }
    if (names.every((n) => certified.has(n))) {
      return "Certificates for these names already exist; use certbot_renew";
    }
    return undefined;
  }

  async function steps(list: Step[]): Promise<{ ok: boolean; output: string }> {
    const output: string[] = [];
    for (const step of list) {
      const r = await run(step);
      output.push(`$ ${step.bin} ${step.args.join(" ")}`);
      const text = `${r.stdout}\n${r.stderr}`.trim();
      if (text) output.push(text);
      if (r.code !== 0) {
        output.push(`exit status ${r.code}`);
        return { ok: false, output: scrub(output.join("\n")).slice(-OUTPUT_CAP) };
      }
    }
    return { ok: true, output: scrub(output.join("\n")).slice(-OUTPUT_CAP) || "OK" };
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
    const upstream = await verifyUpstream(project, book);
    if (upstream) return upstream;
    if (book.prerequisite && book.domain) return checkIssuePrerequisite(project, book.domain);
    return undefined;
  }

  async function dryRun(body: Record<string, unknown>): Promise<RunnerResponse> {
    const { project, book } = parseRunbook(body);
    return serialized(async () => {
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
      tokenExpiresAt: Number(body.tokenExpiresAt),
    };
    if (
      !/^[A-Za-z0-9_-]{16}$/.test(claims.approvalId) ||
      !claims.incidentId ||
      claims.incidentId.length > 150
    ) {
      return bad(400, "approvalId and incidentId are required");
    }
    const token = typeof body.approvalToken === "string" ? body.approvalToken : "";
    const refusal = checkApprovalToken(deps.secret, claims, token, deps.now());
    if (refusal) {
      deps.log({ event: "refused", approvalId: claims.approvalId, reason: refusal });
      return bad(403, refusal);
    }
    return serialized(async () => {
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
        params,
      });
      let result: { ok: boolean; output: string };
      try {
        const refused = await guarded(project, book);
        result = refused ? { ok: false, output: refused } : await steps(book.run);
      } catch (error) {
        result = { ok: false, output: `Runner error: ${(error as Error).message}` };
      }
      deps.ledger.complete(claims.approvalId, result.ok, deps.now());
      deps.log({ event: "finished", approvalId: claims.approvalId, ok: result.ok });
      return { status: 200, body: { ...result } };
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
      if (path === "/v1/runbooks/dry-run") return await dryRun(body);
      if (path === "/v1/runbooks/execute") return await execute(body);
      return bad(404, "Not found");
    } catch (error) {
      if (error instanceof Denied) return bad(403, error.message);
      deps.log({ event: "error", message: (error as Error).message });
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
