import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerClient } from "@incidentpulse/runner-client";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRunbook } from "../src/commands.ts";
import type { Exec } from "../src/exec.ts";
import { buildPlan } from "../src/plan.ts";
import { type Policy, parsePolicy } from "../src/policy.ts";
import {
  createHttpServer,
  createRunner,
  errorCode,
  filePause,
  MAX_WAITING_JOBS,
  memoryPause,
} from "../src/server.ts";
import { type Ledger, signApproval, TOKEN_LIFETIME_MS } from "../src/token.ts";
import { policy, SECRET } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const RESTART = "/usr/bin/sudo -n -H -- /usr/bin/pm2 restart KERVAN";
const CERTS_KERVAN =
  "Certificate Name: kervan.uz\n    Domains: kervan.uz www.kervan.uz\n    Expiry Date: 2027-01-05 10:11:12+00:00 (VALID: 59 days)\n";

/** An exec whose commands wait until the test releases them, to hold the single runner slot. */
function gatedExec(onCall?: (line: string) => void) {
  const waiting: Array<() => void> = [];
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = `${file} ${args.join(" ")}`;
    calls.push(line);
    onCall?.(line);
    if (line === RESTART) await new Promise<void>((resolve) => waiting.push(resolve));
    if (line.endsWith("pm2 jlist")) return { code: 0, stdout: "[]", stderr: "" };
    if (line.endsWith("certbot certificates")) return { code: 0, stdout: CERTS_KERVAN, stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const release = () => waiting.shift()?.();
  return { exec, calls, release, held: () => waiting.length };
}

function ledgerSpy(): Ledger & {
  claimed: string[];
  refused: Array<[string, string]>;
  done: unknown[];
} {
  const claimed: string[] = [];
  const refused: Array<[string, string]> = [];
  const done: unknown[] = [];
  return {
    claimed,
    refused,
    done,
    claim: (id) => {
      if (claimed.includes(id)) return false;
      claimed.push(id);
      return true;
    },
    complete: (id, ok, _at, failedStep) => {
      done.push({ id, ok, failedStep });
    },
    refuse: (id, reason) => {
      refused.push([id, reason]);
    },
  };
}

function setup(exec: Exec, using: Policy = policy, pause = memoryPause()) {
  const clock = { now: NOW };
  const ledger = ledgerSpy();
  const events: Record<string, unknown>[] = [];
  const runner = createRunner({
    policy: using,
    exec,
    secret: SECRET,
    ledger,
    now: () => clock.now,
    probeLocal: async () => 200,
    log: (e) => events.push(e),
    resolve4: async () => ["203.0.113.10"],
    serverAddresses: () => ["203.0.113.10"],
    pause,
  });
  return { runner, clock, ledger, events, pause };
}

const planOf = (
  runbookId: string,
  params: Record<string, string>,
  using: Policy = policy,
): string =>
  buildPlan(using, "kervan", resolveRunbook(using, "kervan", runbookId, params), params).planDigest;

function request(
  runbookId: string,
  params: Record<string, string>,
  approvalId = "AAAAAAAAAAAAAAAA",
  clock = NOW,
  using: Policy = policy,
  expiresIn = TOKEN_LIFETIME_MS,
) {
  const claims = {
    approvalId,
    incidentId: "inc-1",
    project: "kervan",
    runbookId,
    params,
    planDigest: planOf(runbookId, params, using),
    tokenExpiresAt: clock + expiresIn,
  };
  return { ...claims, approvalToken: signApproval(SECRET, claims) };
}

const execute = (runner: ReturnType<typeof setup>["runner"], body: Record<string, unknown>) =>
  runner.handle("POST", "/v1/runbooks/execute", body);
const idN = (n: number) => `${String(n).padStart(16, "A")}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("plan digest (H2/M4)", () => {
  test("/v1/runbooks/plan returns the digest, the policy digest and a readable summary", async () => {
    const { runner } = setup(gatedExec().exec);
    const r = await runner.handle("POST", "/v1/runbooks/plan", {
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "KERVAN" },
    });
    expect(r.status).toBe(200);
    expect(r.body.planDigest).toBe(planOf("pm2_restart", { app: "KERVAN" }));
    expect(r.body.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.summary).toEqual([
      "project: kervan",
      "runbook: pm2_restart",
      "app: KERVAN",
      "commands:",
      "$ /usr/bin/pm2 restart KERVAN",
    ]);
  });

  test("the plan refuses what the policy denies", async () => {
    const { runner } = setup(gatedExec().exec);
    const r = await runner.handle("POST", "/v1/runbooks/plan", {
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "SOMETHING-ELSE" },
    });
    expect(r.status).toBe(403);
  });

  test("a valid token for a DIFFERENT plan digest is refused and nothing runs", async () => {
    const host = gatedExec();
    const { runner, ledger, events } = setup(host.exec);
    const body = request("pm2_restart", { app: "KERVAN" });
    // The token is genuine for this (wrong) digest, but the runner recomputes the digest from its own policy.
    const wrong = { ...body, planDigest: "f".repeat(64) };
    const claims = { ...wrong };
    const forged = {
      ...wrong,
      approvalToken: signApproval(SECRET, {
        approvalId: claims.approvalId,
        incidentId: claims.incidentId,
        project: claims.project,
        runbookId: claims.runbookId,
        params: claims.params,
        planDigest: claims.planDigest,
        tokenExpiresAt: claims.tokenExpiresAt,
      }),
    };
    const r = await execute(runner, forged);
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("Plan digest mismatch");
    expect(host.calls).toEqual([]);
    expect(ledger.claimed).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: "plan_mismatch" }));
  });

  test("a changed host policy invalidates an approval that was given under the old one", async () => {
    const host = gatedExec();
    const changed = parsePolicy({
      projects: {
        kervan: {
          domains: ["kervan.uz"],
          www: true,
          pm2: ["KERVAN", "KERVAN-REACT", "EXTRA"],
          nginx: true,
          webroot: "/var/www/acme",
        },
        codetrail: {
          domains: ["codetrail.example.com"],
          containers: ["codetrail-app"],
          compose: { name: "codetrail", file: "/srv/codetrail/compose.yaml" },
        },
      },
    });
    const { runner } = setup(host.exec, changed);
    const r = await execute(runner, request("pm2_restart", { app: "KERVAN" }));
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("a new approval is required");
    expect(host.calls).toEqual([]);
  });

  test("a changed host command changes the digest under the same policy file", () => {
    const params = { app: "KERVAN" };
    const book = resolveRunbook(policy, "kervan", "pm2_restart", params);
    expect(buildPlan(policy, "kervan", { ...book, run: [] }, params).planDigest).not.toBe(
      buildPlan(policy, "kervan", book, params).planDigest,
    );
  });

  test("a missing or malformed digest is a 400", async () => {
    const { runner } = setup(gatedExec().exec);
    const r = await execute(runner, {
      ...request("pm2_restart", { app: "KERVAN" }),
      planDigest: "x",
    });
    expect(r.status).toBe(400);
  });
});

describe("expiry while queued (M1)", () => {
  test("a job whose token expired while it waited behind a long run is refused, not claimed", async () => {
    const host = gatedExec();
    const { runner, clock, ledger, events } = setup(host.exec);
    const first = execute(runner, request("pm2_restart", { app: "KERVAN" }, idN(1)));
    await tick();
    expect(host.held()).toBe(1);
    // The second approval has 3 minutes left; the first job keeps the runner busy for longer than that.
    const second = execute(
      runner,
      request("pm2_restart", { app: "KERVAN-REACT" }, idN(2), NOW, policy, 180_000),
    );
    await tick();
    clock.now += 200_000;
    host.release();
    expect((await first).body).toMatchObject({ ok: true });
    const late = await second;
    expect(late.status).toBe(403);
    expect(String(late.body.output)).toContain("expired");
    expect(ledger.claimed).toEqual([idN(1)]);
    expect(ledger.refused).toEqual([[idN(2), "expired_in_queue"]]);
    expect(host.calls.some((c) => c.includes("KERVAN-REACT"))).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "refused", approvalId: idN(2), reason: "expired_in_queue" }),
    );
  });

  test("the first step re-checks expiry too (a long read between pickup and the step)", async () => {
    // guarded() performs inventory reads for certbot_nginx_issue; the token runs out during them.
    const clockRef = { now: NOW };
    const exec: Exec = async (file, args) => {
      const line = `${file} ${args.join(" ")}`;
      if (line.endsWith("certbot certificates")) {
        clockRef.now += 20 * 60_000; // the inventory read "takes" 20 minutes
        return { code: 0, stdout: "", stderr: "" };
      }
      if (line.endsWith("nginx -T")) {
        return {
          code: 0,
          stdout: "server { listen 80; server_name kervan.uz www.kervan.uz; }",
          stderr: "",
        };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const calls: string[] = [];
    const wrapped: Exec = async (file, args, o) => {
      calls.push(`${file} ${args.join(" ")}`);
      return exec(file, args, o);
    };
    const ledger = ledgerSpy();
    const runner = createRunner({
      policy,
      exec: wrapped,
      secret: SECRET,
      ledger,
      now: () => clockRef.now,
      probeLocal: async () => 200,
      log: () => undefined,
      resolve4: async () => ["203.0.113.10"],
      serverAddresses: () => ["203.0.113.10"],
    });
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      request("certbot_nginx_issue", { domain: "kervan.uz" }),
    );
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("expired before the first mutating step");
    expect(calls.some((c) => c.includes("certonly") || c.includes("--redirect"))).toBe(false);
    expect(ledger.done).toEqual([{ id: "AAAAAAAAAAAAAAAA", ok: false, failedStep: 0 }]);
  });

  test("rechecks after nginx -t when reload is the first mutation", async () => {
    const commands: string[] = [];
    const { runner, clock, ledger } = setup(async (_file, args) => {
      commands.push(args.join(" "));
      clock.now += TOKEN_LIFETIME_MS;
      return { code: 0, stdout: "ok", stderr: "" };
    });
    const result = await execute(runner, request("nginx_reload", {}));
    expect(result.body).toMatchObject({ ok: false });
    expect(commands).toEqual(["-n -H -- /usr/sbin/nginx -t"]);
    expect(ledger.refused).toEqual([["AAAAAAAAAAAAAAAA", "expired_before_mutation"]]);
  });
});

describe("queue limit (M1/H3)", () => {
  test(`at most ${MAX_WAITING_JOBS} jobs wait; the next request is refused with 429 and queued nothing`, async () => {
    const host = gatedExec();
    const { runner, events, ledger } = setup(host.exec);
    const running = execute(runner, request("pm2_restart", { app: "KERVAN" }, idN(0)));
    await tick();
    const waiting = Array.from({ length: MAX_WAITING_JOBS }, () =>
      runner.handle("POST", "/v1/runbooks/dry-run", {
        project: "kervan",
        runbookId: "pm2_restart",
        params: { app: "KERVAN" },
      }),
    );
    await tick();
    const extra = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "KERVAN" },
    });
    expect(extra.status).toBe(429);
    const extraExecute = await execute(runner, request("pm2_restart", { app: "KERVAN" }, idN(9)));
    expect(extraExecute.status).toBe(429);
    expect(ledger.claimed).toEqual([idN(0)]); // the refused execute was never claimed
    expect(events.filter((e) => e.reason === "queue_full")).toHaveLength(2);
    host.release();
    await running;
    await Promise.all(waiting);
  });
});

describe("runner pause (M2)", () => {
  test("/v1/pause refuses execution (423), keeps reads working, /v1/resume lifts it", async () => {
    const host = gatedExec();
    const { runner, ledger } = setup(host.exec);
    const paused = await runner.handle("POST", "/v1/pause", {});
    expect(paused.body).toMatchObject({ ok: true, paused: true, running: [], queued: [] });
    const refused = await execute(runner, request("pm2_restart", { app: "KERVAN" }));
    expect(refused.status).toBe(423);
    expect(ledger.claimed).toEqual([]);
    expect(ledger.refused).toEqual([["AAAAAAAAAAAAAAAA", "paused"]]);
    expect((await runner.handle("POST", "/v1/read", { op: "pm2_jlist" })).status).toBe(200);
    expect(host.calls.some((c) => c.includes("restart"))).toBe(false);

    const resumed = await runner.handle("POST", "/v1/resume", {});
    expect(resumed.body).toMatchObject({ paused: false });
    host.release();
    const run = execute(runner, request("pm2_restart", { app: "KERVAN" }));
    await tick();
    host.release();
    expect((await run).body).toMatchObject({ ok: true });
  });

  test("a queued job is refused at pickup when the runner was paused while it waited", async () => {
    const host = gatedExec();
    const { runner, ledger } = setup(host.exec);
    const first = execute(runner, request("pm2_restart", { app: "KERVAN" }, idN(1)));
    await tick();
    const second = execute(runner, request("pm2_restart", { app: "KERVAN-REACT" }, idN(2)));
    await tick();
    const status = await runner.handle("POST", "/v1/pause", {});
    // /stop shows what is running and what waits behind it.
    expect(status.body).toMatchObject({
      paused: true,
      running: [{ kind: "execute", runbookId: "pm2_restart", approvalId: idN(1) }],
      queued: [{ kind: "execute", runbookId: "pm2_restart", approvalId: idN(2) }],
    });
    host.release();
    expect((await first).body).toMatchObject({ ok: true });
    expect((await second).status).toBe(423);
    expect(ledger.refused).toEqual([[idN(2), "paused"]]);
    expect(host.calls.some((c) => c.includes("KERVAN-REACT"))).toBe(false);
  });

  test("pause is checked between steps: the run stops before the next step and says how far it got", async () => {
    const pause = memoryPause();
    const certs = (line: string) => line.endsWith("certbot certificates");
    const exec: Exec = async (file, args) => {
      const line = `${file} ${args.join(" ")}`;
      if (certs(line)) return { code: 0, stdout: CERTS_KERVAN, stderr: "" };
      // the operator hits /stop while the staging run (step 1) is executing
      if (line.includes("--dry-run")) pause.set(true);
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const calls: string[] = [];
    const { runner, ledger, events } = setup(
      async (file, args, o) => {
        calls.push(`${file} ${args.join(" ")}`);
        return exec(file, args, o);
      },
      policy,
      pause,
    );
    const r = await execute(runner, request("certbot_renew", { domain: "kervan.uz" }));
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("stopped before step 2 of 4");
    expect(String(r.body.output)).toContain("paused");
    expect(
      calls.some(
        (c) => c.endsWith("--non-interactive --no-directory-hooks") && !c.includes("--dry-run"),
      ),
    ).toBe(false);
    expect(calls.some((c) => c.includes("reload"))).toBe(false);
    expect(ledger.done).toEqual([{ id: "AAAAAAAAAAAAAAAA", ok: false, failedStep: 1 }]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "finished", ok: false, failedStep: 1 }),
    );
  });

  test("GET /v1/status reports the pause state", async () => {
    const { runner } = setup(gatedExec().exec);
    expect((await runner.handle("GET", "/v1/status", {})).body).toMatchObject({ paused: false });
    await runner.handle("POST", "/v1/pause", {});
    expect((await runner.handle("GET", "/v1/status", {})).body).toMatchObject({ paused: true });
  });

  test("the file-backed switch survives a restart of the runner", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ip-pause-")), "paused");
    const first = filePause(path);
    expect(first.isPaused()).toBe(false);
    first.set(true);
    expect(filePause(path).isPaused()).toBe(true);
    first.set(false);
    expect(filePause(path).isPaused()).toBe(false);
    first.set(false); // idempotent
  });
});

describe("error codes only (M9)", () => {
  test("errorCode never returns a message", () => {
    expect(errorCode(new Error("password=hunter2 failed in /etc/secret"))).toBe("Error");
    expect(errorCode(Object.assign(new Error("boom /x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode(new Error("PM2_FAILED"))).toBe("PM2_FAILED");
    expect(errorCode("a string with a token=abc")).toBe("UNKNOWN");
  });

  test("the runner's error log and its response carry a code, not the exception text", async () => {
    const secretText = "token=SUPERSECRETVALUE leaked from /etc/incidentpulse/key";
    const exec: Exec = async () => {
      throw new Error(secretText);
    };
    const { runner, events } = setup(exec);
    const read = await runner.handle("POST", "/v1/read", { op: "pm2_jlist" });
    expect(read.status).toBe(500);
    expect(JSON.stringify(events)).not.toContain("SUPERSECRETVALUE");
    expect(events).toContainEqual({ event: "error", code: "Error" });

    const run = await execute(runner, request("certbot_renew", { domain: "kervan.uz" }));
    expect(run.body.output).toBe("Runner error: Error");
    expect(JSON.stringify(run.body)).not.toContain("SUPERSECRETVALUE");
    expect(JSON.stringify(events)).not.toContain("SUPERSECRETVALUE");
  });
});

describe("pause, resume and status over the unix socket", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  test("the runner client reaches the new endpoints", async () => {
    const { runner } = setup(gatedExec().exec);
    const server = createHttpServer(runner);
    const socketPath = join(mkdtempSync(join(tmpdir(), "ip-")), "r.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup = () => server.close();
    const client = createRunnerClient({ socketPath });
    expect(await client.status()).toEqual({ paused: false, running: [], queued: [] });
    expect((await client.pause()).paused).toBe(true);
    expect((await client.status()).paused).toBe(true);
    expect((await client.resume()).paused).toBe(false);
    const plan = await client.plan({
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "KERVAN" },
    });
    expect(plan.planDigest).toBe(planOf("pm2_restart", { app: "KERVAN" }));
    expect(plan.summary).toContain("app: KERVAN");
  });
});
