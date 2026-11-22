import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerClient } from "@incidentpulse/runner-client";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRunbook } from "../src/commands.ts";
import { buildPlan } from "../src/plan.ts";
import type { Policy } from "../src/policy.ts";
import { createHttpServer, createRunner, memoryPause } from "../src/server.ts";
import { type Ledger, signApproval, TOKEN_LIFETIME_MS } from "../src/token.ts";
import {
  CERTS,
  fakeExec,
  NGINX_DUMP,
  NGINX_DUMP_CONF_D,
  PM2_JLIST,
  PS_OUTPUT,
  policy,
  policyNoWww,
  SECRET,
  SS_OUTPUT,
} from "./helpers.ts";

const NOW = 1_800_000_000_000;
const sudo = (cmd: string) => `sudo ${cmd}`;
const KERVAN_VHOST = `${NGINX_DUMP}\nhttp { server { listen 80; server_name kervan.uz www.kervan.uz; } }`;

function memoryLedger(): Ledger & {
  claimed: string[];
  completed: Array<{ id: string; ok: boolean; failedStep?: number | undefined }>;
  refused: Array<{ id: string; reason: string }>;
} {
  const claimed: string[] = [];
  const completed: Array<{ id: string; ok: boolean; failedStep?: number | undefined }> = [];
  const refused: Array<{ id: string; reason: string }> = [];
  return {
    claimed,
    completed,
    refused,
    claim: (id) => {
      if (claimed.includes(id)) return false;
      claimed.push(id);
      return true;
    },
    complete: (id, ok, _at, failedStep) => {
      completed.push({ id, ok, failedStep });
    },
    refuse: (id, reason) => {
      refused.push({ id, reason });
    },
  };
}

/** DNS answers: both Kervan names point at this server unless a test says otherwise. */
const HERE = "203.0.113.10";
const dnsHere = async (host: string) => (/kervan\.uz$/.test(host) ? [HERE] : []);

function build(
  answers: Parameters<typeof fakeExec>[0],
  probe: number | undefined = 200,
  using: Policy = policy,
  extra: Partial<Parameters<typeof createRunner>[0]> = {},
) {
  const { exec, calls } = fakeExec({
    [sudo("/usr/bin/pm2 jlist")]: { stdout: PM2_JLIST },
    [sudo("/usr/bin/ss -H -ltnp")]: { stdout: SS_OUTPUT },
    "/usr/bin/ps -eo pid=,ppid=": { stdout: PS_OUTPUT },
    ...answers,
  });
  const ledger = memoryLedger();
  const events: Record<string, unknown>[] = [];
  const pause = memoryPause();
  const clock = { now: NOW };
  const runner = createRunner({
    policy: using,
    exec,
    secret: SECRET,
    ledger,
    now: () => clock.now,
    probeLocal: async () => probe,
    log: (e) => events.push(e),
    resolve4: dnsHere,
    serverAddresses: () => [HERE],
    pause,
    ...extra,
  });
  return { runner, calls, ledger, events, pause, clock };
}

/** The digest the orchestrator stored at proposal time = what the runner computes for the same plan. */
const digestOf = (
  runbookId: string,
  params: Record<string, string>,
  using: Policy = policy,
  project = "kervan",
) => {
  try {
    return buildPlan(using, project, resolveRunbook(using, project, runbookId, params), params)
      .planDigest;
  } catch {
    return "0".repeat(64); // a request the policy denies: the digest is irrelevant, the denial is the point
  }
};

const execBody = (
  runbookId: string,
  params: Record<string, string>,
  over = {},
  using: Policy = policy,
) => {
  const base = {
    approvalId: "AAAAAAAAAAAAAAAA",
    incidentId: "inc-1",
    project: "kervan",
    runbookId,
    params,
    planDigest: digestOf(runbookId, params, using),
    tokenExpiresAt: NOW + TOKEN_LIFETIME_MS,
  };
  return { ...base, approvalToken: signApproval(SECRET, base), ...over };
};

describe("read-only operations", () => {
  test("pm2_jlist returns only allowlisted apps", async () => {
    const { runner } = build({});
    const r = await runner.handle("POST", "/v1/read", { op: "pm2_jlist" });
    expect(r.status).toBe(200);
    expect((r.body.apps as { name: string }[]).map((a) => a.name)).toEqual([
      "KERVAN",
      "KERVAN-REACT",
    ]);
  });

  test("pm2_ports maps listeners to apps", async () => {
    const { runner } = build({});
    const r = await runner.handle("POST", "/v1/read", { op: "pm2_ports" });
    expect(r.body.apps).toEqual([
      { app: "KERVAN", pid: 100, ports: [3000] },
      { app: "KERVAN-REACT", pid: 200, ports: [3001] },
    ]);
  });

  test("pm2_logs refuses an app outside the policy and never runs a command for it", async () => {
    const { runner, calls } = build({});
    const r = await runner.handle("POST", "/v1/read", {
      op: "pm2_logs",
      args: { app: "SOMETHING-ELSE" },
    });
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.includes("logs"))).toBe(false);
  });

  test("pm2_logs returns the tail", async () => {
    const { runner } = build({
      [sudo("/usr/bin/pm2 logs KERVAN --nostream --lines 200")]: { stdout: "a\nb\nc\n" },
    });
    const r = await runner.handle("POST", "/v1/read", {
      op: "pm2_logs",
      args: { app: "KERVAN", lines: 2 },
    });
    expect(r.body.lines).toEqual(["b", "c"]);
  });

  test("nginx_config exposes only the policy's domains, never other vhosts", async () => {
    const { runner } = build({ [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST } });
    const r = await runner.handle("POST", "/v1/read", { op: "nginx_config" });
    expect(r.body.servers).toEqual([
      { names: ["kervan.uz", "www.kervan.uz"], listens: ["80"], ssl: false, proxyPass: [] },
    ]);
  });

  test("cert_list hides certificates of domains outside the policy", async () => {
    const { runner } = build({ [sudo("/usr/bin/certbot certificates")]: { stdout: CERTS } });
    const r = await runner.handle("POST", "/v1/read", { op: "cert_list" });
    expect(r.body.certificates).toEqual([]);
  });

  test("unknown operations and routes are refused", async () => {
    const { runner } = build({});
    expect((await runner.handle("POST", "/v1/read", { op: "shell" })).status).toBe(400);
    expect((await runner.handle("GET", "/v1/exec", {})).status).toBe(404);
    expect((await runner.handle("POST", "/v1/anything", {})).status).toBe(404);
  });
});

describe("dry-run", () => {
  test("runs the dry-run commands without a token", async () => {
    const { runner, calls } = build({
      [sudo("/usr/bin/pm2 describe KERVAN")]: { stdout: "online" },
    });
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "KERVAN" },
    });
    expect(r.body).toMatchObject({ ok: true });
    expect(calls.at(-1)).toBe(sudo("/usr/bin/pm2 describe KERVAN"));
  });

  test("nginx_site_proxy: an upstream that no allowlisted pm2 app owns is refused before any helper runs", async () => {
    const { runner, calls } = build({ [sudo("/usr/sbin/nginx -T")]: { stdout: NGINX_DUMP } });
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:9999" },
    });
    expect(r.body.ok).toBe(false);
    expect(String(r.body.output)).toContain("not a listening port of this project's pm2 apps");
    expect(calls.some((c) => c.includes("nginx-site.ts"))).toBe(false);
  });

  test("nginx_site_proxy: an owned, healthy upstream reaches the helper in check mode", async () => {
    const helper = sudo(
      "/opt/incidentpulse/node/bin/node /opt/incidentpulse/actions-runner/src/nginx-site.ts check kervan.uz 127.0.0.1:3000",
    );
    const { runner } = build({
      [helper]: { stdout: "would create" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: NGINX_DUMP },
    });
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
    });
    expect(r.body).toMatchObject({ ok: true });
  });

  test("nginx_site_proxy: an upstream answering 502 is refused", async () => {
    const { runner } = build({ [sudo("/usr/sbin/nginx -T")]: { stdout: NGINX_DUMP } }, 502);
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
    });
    expect(r.body.ok).toBe(false);
  });

  const issueBody = {
    project: "kervan",
    runbookId: "certbot_nginx_issue",
    params: { domain: "kervan.uz" },
  };
  const issued = `Found the following certs:\n  Certificate Name: kervan.uz\n    Domains: kervan.uz www.kervan.uz\n    Expiry Date: 2027-01-05 10:11:12+00:00 (VALID: 59 days)\n`;
  const expired = `Found the following certs:\n  Certificate Name: kervan.uz\n    Domains: kervan.uz www.kervan.uz\n    Expiry Date: 2026-11-01 10:11:12+00:00 (EXPIRED)\n`;

  test("certbot_nginx_issue: static checks only, and a certbot command is NEVER run before approval", async () => {
    const ready = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: "" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
      [sudo("/usr/sbin/nginx -t")]: { stderr: "test is successful" },
    });
    const r = await ready.runner.handle("POST", "/v1/runbooks/dry-run", issueBody);
    expect(r.body).toMatchObject({ ok: true });
    // Inventory reads and `nginx -t` only: the staging certbot run edits the live nginx and waits for approval.
    expect(ready.calls.filter((c) => /certbot/.test(c) && !/certificates$/.test(c))).toEqual([]);
    expect(ready.calls.some((c) => c.includes("--dry-run"))).toBe(false);
    expect(ready.calls.at(-1)).toBe(sudo("/usr/sbin/nginx -t"));
  });

  test("certbot_nginx_issue needs an existing vhost", async () => {
    const noVhost = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: "" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: NGINX_DUMP },
    });
    const first = await noVhost.runner.handle("POST", "/v1/runbooks/dry-run", issueBody);
    expect(String(first.body.output)).toContain("create the vhost first (nginx_site_proxy)");
  });

  test("certbot_nginx_issue: DNS A must point at this server", async () => {
    const answers = {
      [sudo("/usr/bin/certbot certificates")]: { stdout: "" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
    };
    const wrong = build(answers, 200, policy, { resolve4: async () => ["198.51.100.7"] });
    const r = await wrong.runner.handle("POST", "/v1/runbooks/dry-run", issueBody);
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("does not point at this server");
    const none = build(answers, 200, policy, { resolve4: async () => [] });
    expect(
      String((await none.runner.handle("POST", "/v1/runbooks/dry-run", issueBody)).body.output),
    ).toContain("(none)");
    expect(wrong.calls.some((c) => c.includes("nginx -t"))).toBe(false);
  });

  test("certbot_nginx_issue: refused while a VALID certificate exists, allowed when it is expired", async () => {
    const valid = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: issued },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
    });
    const first = await valid.runner.handle("POST", "/v1/runbooks/dry-run", issueBody);
    expect(String(first.body.output)).toContain("use certbot_renew");
    const stale = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: expired },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
      [sudo("/usr/sbin/nginx -t")]: { stderr: "test is successful" },
    });
    expect(
      (await stale.runner.handle("POST", "/v1/runbooks/dry-run", issueBody)).body,
    ).toMatchObject({ ok: true });
  });

  test("certbot_renew: static too (certificate must exist, nginx -t), no certbot staging run before approval", async () => {
    const body = { project: "kervan", runbookId: "certbot_renew", params: { domain: "kervan.uz" } };
    const missing = build({ [sudo("/usr/bin/certbot certificates")]: { stdout: "" } });
    expect(
      String((await missing.runner.handle("POST", "/v1/runbooks/dry-run", body)).body.output),
    ).toContain("No certificate named kervan.uz");
    const present = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: issued },
      [sudo("/usr/sbin/nginx -t")]: { stderr: "test is successful" },
    });
    expect((await present.runner.handle("POST", "/v1/runbooks/dry-run", body)).body).toMatchObject({
      ok: true,
    });
    expect(present.calls.some((c) => c.includes("renew"))).toBe(false);
  });
});

describe("execute", () => {
  const restart = { [sudo("/usr/bin/pm2 restart KERVAN")]: { stdout: "restarted" } };

  test("runs the commands once the token verifies, and records the claim", async () => {
    const { runner, calls, ledger } = build(restart);
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("pm2_restart", { app: "KERVAN" }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(calls.at(-1)).toBe(sudo("/usr/bin/pm2 restart KERVAN"));
    expect(ledger.claimed).toEqual(["AAAAAAAAAAAAAAAA"]);
  });

  test("a replay of the same approval is refused and runs nothing", async () => {
    const { runner, calls } = build(restart);
    const body = execBody("pm2_restart", { app: "KERVAN" });
    await runner.handle("POST", "/v1/runbooks/execute", body);
    const before = calls.length;
    const second = await runner.handle("POST", "/v1/runbooks/execute", body);
    expect(second.status).toBe(409);
    expect(calls.length).toBe(before);
  });

  test.each([
    ["no token", { approvalToken: "" }],
    ["a token for another app", { params: { app: "KERVAN-REACT" } }],
    ["an expired token", { tokenExpiresAt: NOW - 1 }],
    [
      "a token signed with another key",
      {
        approvalToken: signApproval("z".repeat(40), {
          approvalId: "AAAAAAAAAAAAAAAA",
          incidentId: "inc-1",
          project: "kervan",
          runbookId: "pm2_restart",
          params: { app: "KERVAN" },
          planDigest: digestOf("pm2_restart", { app: "KERVAN" }),
          tokenExpiresAt: NOW + TOKEN_LIFETIME_MS,
        }),
      },
    ],
  ])("refuses %s and runs nothing", async (_n, over) => {
    const { runner, calls, ledger } = build(restart);
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("pm2_restart", { app: "KERVAN" }, over),
    );
    expect(r.status).toBe(403);
    expect(calls.filter((c) => c.includes("restart"))).toEqual([]);
    expect(ledger.claimed).toEqual([]);
  });

  test("a valid token cannot widen the policy: an app outside it is denied", async () => {
    const { runner, calls } = build(restart);
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("pm2_restart", { app: "SOMETHING-ELSE" }),
    );
    expect(r.status).toBe(403);
    expect(calls.filter((c) => c.includes("restart"))).toEqual([]);
  });

  test("stops at the first failing command, reports it and records the failing step", async () => {
    const certs = sudo("/usr/bin/certbot certificates");
    const stage = sudo(
      "/usr/bin/certbot renew --cert-name kervan.uz --dry-run --non-interactive --no-directory-hooks",
    );
    const renew = sudo(
      "/usr/bin/certbot renew --cert-name kervan.uz --non-interactive --no-directory-hooks",
    );
    const { runner, calls, ledger, events } = build({
      [certs]: {
        stdout:
          "Certificate Name: kervan.uz\n    Domains: kervan.uz\n    Expiry Date: 2027-01-05 10:11:12+00:00 (VALID: 59 days)\n",
      },
      [stage]: { stdout: "The dry run was successful." },
      [renew]: { code: 1, stderr: "rate limited" },
    });
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("certbot_renew", { domain: "kervan.uz" }),
    );
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("rate limited");
    expect(calls.some((c) => c.includes("systemctl"))).toBe(false);
    expect(ledger.completed).toEqual([{ id: "AAAAAAAAAAAAAAAA", ok: false, failedStep: 1 }]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "finished", ok: false, failedStep: 1 }),
    );
  });

  test("never lets a command through a shell: every call is file + argv", async () => {
    const { runner, calls } = build(restart);
    await runner.handle("POST", "/v1/runbooks/execute", execBody("pm2_restart", { app: "KERVAN" }));
    expect(calls.every((c) => !/[;&|`$]/.test(c))).toBe(true);
  });
});

describe("Kervan as it really is: conf.d/kervan.conf, listen 80, no 443, no certificate", () => {
  const siteBody = {
    project: "kervan",
    runbookId: "nginx_site_proxy",
    params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
  };
  const issueBody = {
    project: "kervan",
    runbookId: "certbot_nginx_issue",
    params: { domain: "kervan.uz" },
  };
  const certbotCerts = sudo("/usr/bin/certbot certificates");
  const nginxT = sudo("/usr/sbin/nginx -T");

  test("nginx_config sees a vhost that lives only in conf.d (nginx -T, not sites-enabled)", async () => {
    const { runner, calls } = build({ [nginxT]: { stdout: NGINX_DUMP_CONF_D } }, 200, policyNoWww);
    const r = await runner.handle("POST", "/v1/read", { op: "nginx_config" });
    expect(r.body.servers).toEqual([
      { names: ["kervan.uz"], listens: ["80"], ssl: false, proxyPass: ["http://localhost:3000/"] },
    ]);
    // One privileged read of the whole configuration; it never looks at sites-enabled on its own.
    expect(calls.filter((c) => c.includes("nginx"))).toEqual([nginxT]);
  });

  test.each([
    ["without www", policyNoWww],
    ["with www in the policy", policy],
  ])(
    "nginx_site_proxy is refused outright when conf.d already names the domain (%s)",
    async (_n, using) => {
      const answers = {
        [nginxT]: { stdout: NGINX_DUMP_CONF_D },
        [sudo(
          "/opt/incidentpulse/node/bin/node /opt/incidentpulse/actions-runner/src/nginx-site.ts check kervan.uz 127.0.0.1:3000",
        )]: { stdout: "would create" },
      };
      const dry = build(answers, 200, using);
      const refused = await dry.runner.handle("POST", "/v1/runbooks/dry-run", siteBody);
      expect(refused.body).toMatchObject({ ok: false });
      expect(String(refused.body.output)).toContain("already has a server block for kervan.uz");
      expect(dry.calls.some((c) => c.includes("nginx-site.ts"))).toBe(false);

      // A valid, unexpired approval token does not change that: nothing runs, not even the root helper.
      const real = build(answers, 200, using);
      const executed = await real.runner.handle(
        "POST",
        "/v1/runbooks/execute",
        execBody("nginx_site_proxy", siteBody.params, {}, using),
      );
      expect(executed.body).toMatchObject({ ok: false });
      expect(String(executed.body.output)).toContain("already has a server block");
      expect(real.calls.some((c) => c.includes("nginx-site.ts"))).toBe(false);
    },
  );

  test("certbot_nginx_issue (-d kervan.uz only): the staging run is the first step after approval, then 443 + redirect and nginx -t", async () => {
    const dry = sudo("/usr/bin/certbot certonly --dry-run --non-interactive --nginx -d kervan.uz");
    const issue = sudo("/usr/bin/certbot --nginx -d kervan.uz --non-interactive --redirect");
    const answers = {
      [certbotCerts]: { stdout: "No certificates found." },
      [nginxT]: { stdout: NGINX_DUMP_CONF_D },
      [dry]: { stdout: "The dry run was successful." },
      [issue]: { stdout: "Successfully deployed certificate" },
      [sudo("/usr/sbin/nginx -t")]: { stderr: "test is successful" },
    };
    const first = build(answers, 200, policyNoWww);
    expect(
      (await first.runner.handle("POST", "/v1/runbooks/dry-run", issueBody)).body,
    ).toMatchObject({ ok: true });
    expect(first.calls).not.toContain(dry);

    const second = build(answers, 200, policyNoWww);
    const done = await second.runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("certbot_nginx_issue", issueBody.params, {}, policyNoWww),
    );
    expect(done.body).toMatchObject({ ok: true });
    const certbotCalls = second.calls.filter((c) => /certbot (certonly|--nginx)/.test(c));
    expect(certbotCalls).toEqual([dry, issue]);
    expect(second.calls.some((c) => c.includes("www.kervan.uz"))).toBe(false);
    expect(second.calls.at(-1)).toBe(sudo("/usr/sbin/nginx -t"));
  });

  test("a failing staging run stops the run before the real issuance and is audited", async () => {
    const dry = sudo("/usr/bin/certbot certonly --dry-run --non-interactive --nginx -d kervan.uz");
    const issue = sudo("/usr/bin/certbot --nginx -d kervan.uz --non-interactive --redirect");
    const { runner, calls, ledger, events } = build(
      {
        [certbotCerts]: { stdout: "No certificates found." },
        [nginxT]: { stdout: NGINX_DUMP_CONF_D },
        [dry]: { code: 1, stderr: "Challenge failed for domain kervan.uz" },
        [issue]: { stdout: "must never run" },
      },
      200,
      policyNoWww,
    );
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("certbot_nginx_issue", issueBody.params, {}, policyNoWww),
    );
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("Challenge failed");
    expect(calls).not.toContain(issue);
    expect(calls.some((c) => c.endsWith("nginx -t"))).toBe(false);
    expect(ledger.completed).toEqual([{ id: "AAAAAAAAAAAAAAAA", ok: false, failedStep: 0 }]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "finished", ok: false, failedStep: 0 }),
    );
  });

  test("with www in the policy but only the apex in nginx, certbot is refused with a clear reason", async () => {
    const { runner } = build(
      { [certbotCerts]: { stdout: "" }, [nginxT]: { stdout: NGINX_DUMP_CONF_D } },
      200,
      policy,
    );
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", issueBody);
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("none names www.kervan.uz");
    expect(String(r.body.output)).not.toContain("create the vhost first");
  });
});

describe("HTTP over a unix socket", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  test("serves reads and refuses malformed bodies", async () => {
    const { runner } = build({});
    const server = createHttpServer(runner);
    const socketPath = join(mkdtempSync(join(tmpdir(), "ip-")), "r.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup = () => server.close();
    const client = createRunnerClient({ socketPath });
    expect(await client.health()).toBe(true);
    const ports = await client.read("pm2_ports");
    expect(ports.apps[0]).toMatchObject({ app: "KERVAN", ports: [3000] });
    await expect(client.read("pm2_logs", { app: "SOMETHING-ELSE" })).rejects.toMatchObject({
      code: "pm2 app is not in the policy",
    });
    const outcome = await client.execute({
      project: "kervan",
      runbookId: "pm2_restart",
      params: { app: "KERVAN" },
      approvalId: "AAAAAAAAAAAAAAAA",
      incidentId: "inc-1",
      approvalToken: "bad",
      planDigest: digestOf("pm2_restart", { app: "KERVAN" }),
      tokenExpiresAt: NOW,
    });
    expect(outcome.ok).toBe(false);
  });
});
