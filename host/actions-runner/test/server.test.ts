import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerClient } from "@incidentpulse/runner-client";
import { afterEach, describe, expect, test } from "vitest";
import { createHttpServer, createRunner } from "../src/server.ts";
import { type Ledger, signApproval, TOKEN_LIFETIME_MS } from "../src/token.ts";
import {
  CERTS,
  fakeExec,
  NGINX_DUMP,
  PM2_JLIST,
  PS_OUTPUT,
  policy,
  SECRET,
  SS_OUTPUT,
} from "./helpers.ts";

const NOW = 1_800_000_000_000;
const sudo = (cmd: string) => `sudo ${cmd}`;
const KERVAN_VHOST = `${NGINX_DUMP}\nhttp { server { listen 80; server_name kervan.uz www.kervan.uz; } }`;

function memoryLedger(): Ledger & { claimed: string[] } {
  const claimed: string[] = [];
  return {
    claimed,
    claim: (id) => {
      if (claimed.includes(id)) return false;
      claimed.push(id);
      return true;
    },
    complete: () => undefined,
  };
}

function build(answers: Parameters<typeof fakeExec>[0], probe: number | undefined = 200) {
  const { exec, calls } = fakeExec({
    [sudo("/usr/bin/pm2 jlist")]: { stdout: PM2_JLIST },
    [sudo("/usr/bin/ss -H -ltnp")]: { stdout: SS_OUTPUT },
    "/usr/bin/ps -eo pid=,ppid=": { stdout: PS_OUTPUT },
    ...answers,
  });
  const ledger = memoryLedger();
  const events: Record<string, unknown>[] = [];
  const runner = createRunner({
    policy,
    exec,
    secret: SECRET,
    ledger,
    now: () => NOW,
    probeLocal: async () => probe,
    log: (e) => events.push(e),
  });
  return { runner, calls, ledger, events };
}

const execBody = (runbookId: string, params: Record<string, string>, over = {}) => {
  const base = {
    approvalId: "AAAAAAAAAAAAAAAA",
    incidentId: "inc-1",
    project: "kervan",
    runbookId,
    params,
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
    const { runner, calls } = build({});
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
    const { runner } = build({ [helper]: { stdout: "would create" } });
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
    });
    expect(r.body).toMatchObject({ ok: true });
  });

  test("nginx_site_proxy: an upstream answering 502 is refused", async () => {
    const { runner } = build({}, 502);
    const r = await runner.handle("POST", "/v1/runbooks/dry-run", {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
    });
    expect(r.body.ok).toBe(false);
  });

  test("certbot_nginx_issue needs a vhost first, and no certificate yet", async () => {
    const noVhost = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: "" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: NGINX_DUMP },
    });
    const body = {
      project: "kervan",
      runbookId: "certbot_nginx_issue",
      params: { domain: "kervan.uz" },
    };
    const first = await noVhost.runner.handle("POST", "/v1/runbooks/dry-run", body);
    expect(String(first.body.output)).toContain("create the vhost first (nginx_site_proxy)");

    const issued = `Found the following certs:\n  Certificate Name: kervan.uz\n    Domains: kervan.uz www.kervan.uz\n    Expiry Date: 2027-01-05 10:11:12+00:00 (VALID: 59 days)\n`;
    const haveCert = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: issued },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
    });
    const second = await haveCert.runner.handle("POST", "/v1/runbooks/dry-run", body);
    expect(String(second.body.output)).toContain("use certbot_renew");

    const dry = sudo(
      "/usr/bin/certbot certonly --dry-run --non-interactive --webroot -w /var/www/acme -d kervan.uz -d www.kervan.uz",
    );
    const ready = build({
      [sudo("/usr/bin/certbot certificates")]: { stdout: "" },
      [sudo("/usr/sbin/nginx -T")]: { stdout: KERVAN_VHOST },
      [dry]: { stdout: "The dry run was successful." },
    });
    expect((await ready.runner.handle("POST", "/v1/runbooks/dry-run", body)).body).toMatchObject({
      ok: true,
    });
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

  test("stops at the first failing command and reports it", async () => {
    const renew = sudo(
      "/usr/bin/certbot renew --cert-name kervan.uz --non-interactive --no-directory-hooks",
    );
    const { runner, calls } = build({ [renew]: { code: 1, stderr: "rate limited" } });
    const r = await runner.handle(
      "POST",
      "/v1/runbooks/execute",
      execBody("certbot_renew", { domain: "kervan.uz" }),
    );
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.output)).toContain("rate limited");
    expect(calls.some((c) => c.includes("systemctl"))).toBe(false);
  });

  test("never lets a command through a shell: every call is file + argv", async () => {
    const { runner, calls } = build(restart);
    await runner.handle("POST", "/v1/runbooks/execute", execBody("pm2_restart", { app: "KERVAN" }));
    expect(calls.every((c) => !/[;&|`$]/.test(c))).toBe(true);
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
      tokenExpiresAt: NOW,
    });
    expect(outcome.ok).toBe(false);
  });
});
