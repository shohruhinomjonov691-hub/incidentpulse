import { describe, expect, test } from "vitest";
import { renderSudoers } from "../scripts/render-sudoers.ts";
import { Denied, privilegedSteps, resolveRunbook, siteHelperRules } from "../src/commands.ts";
import { policy } from "./helpers.ts";

const resolve = (project: string, id: string, params: Record<string, string>) =>
  resolveRunbook(policy, project, id, params);

describe("runbook resolution", () => {
  test("certbot_nginx_issue covers www, and is medium risk", () => {
    const book = resolve("kervan", "certbot_nginx_issue", { domain: "kervan.uz" });
    expect(book.risk).toBe("medium");
    expect(book.dryRun[0]?.args).toEqual([
      "certonly",
      "--dry-run",
      "--non-interactive",
      "--webroot",
      "-w",
      "/var/www/acme",
      "-d",
      "kervan.uz",
      "-d",
      "www.kervan.uz",
    ]);
    expect(book.run[0]?.args).toEqual([
      "--nginx",
      "-d",
      "kervan.uz",
      "-d",
      "www.kervan.uz",
      "--non-interactive",
      "--redirect",
    ]);
  });

  test("nginx_site_proxy is medium risk, takes a loopback port, runs the root helper", () => {
    const book = resolve("kervan", "nginx_site_proxy", {
      domain: "kervan.uz",
      upstream: "127.0.0.1:3000",
    });
    expect(book.risk).toBe("medium");
    expect(book.upstream).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(book.run[0]).toMatchObject({
      bin: "node",
      sudo: true,
      args: [
        "/opt/incidentpulse/actions-runner/src/nginx-site.ts",
        "apply",
        "kervan.uz",
        "127.0.0.1:3000",
      ],
    });
    expect(book.dryRun[0]?.args[1]).toBe("check");
  });

  test.each([
    ["unknown project", "nope", "nginx_reload", {}],
    ["unknown runbook", "kervan", "rm_rf", {}],
    ["foreign domain", "kervan", "certbot_renew", { domain: "codetrail.example.com" }],
    ["www as a cert name", "kervan", "certbot_renew", { domain: "www.kervan.uz" }],
    ["extra param", "kervan", "nginx_reload", { x: "1" }],
    ["missing param", "kervan", "pm2_restart", {}],
    ["pm2 app of another project", "codetrail", "pm2_restart", { app: "KERVAN" }],
    ["container outside the policy", "codetrail", "docker_restart", { service: "kervan-db" }],
    ["nginx not enabled", "codetrail", "nginx_reload", {}],
    [
      "public upstream",
      "kervan",
      "nginx_site_proxy",
      { domain: "kervan.uz", upstream: "10.0.0.5:3000" },
    ],
    [
      "hostname upstream",
      "kervan",
      "nginx_site_proxy",
      { domain: "kervan.uz", upstream: "localhost:3000" },
    ],
    [
      "privileged port",
      "kervan",
      "nginx_site_proxy",
      { domain: "kervan.uz", upstream: "127.0.0.1:80" },
    ],
    [
      "upstream with a path",
      "kervan",
      "nginx_site_proxy",
      { domain: "kervan.uz", upstream: "127.0.0.1:3000/x" },
    ],
    ["compose with another name", "codetrail", "docker_compose_up", { project: "other" }],
  ])("denies %s", (_name, project, id, params) => {
    expect(() => resolve(project, id, params as Record<string, string>)).toThrow(Denied);
  });
});

describe("sudoers", () => {
  const text = renderSudoers(policy);
  const rules = text.split("\n").filter((l) => l.startsWith("    "));

  test("lists exact commands only, from the policy", () => {
    expect(text).toContain("/usr/bin/pm2 restart KERVAN-REACT");
    expect(text).toContain("/usr/bin/pm2 logs KERVAN --nostream --lines 200");
    expect(text).toContain("/usr/sbin/nginx -T");
    expect(text).toContain("/usr/bin/certbot certificates");
    expect(text).toContain("/usr/bin/docker restart codetrail-app");
    expect(text).toContain("/usr/bin/ss -H -ltnp");
    expect(text).not.toMatch(/\bbash\b|\bsh\b|\btee\b|\brm\b/);
  });

  test("the only patterns are the helper's loopback port classes", () => {
    const wild = rules.filter((l) => /[*?[]/.test(l));
    expect(wild.length).toBeGreaterThan(0);
    for (const line of wild) {
      expect(line).toMatch(/nginx-site\.ts (check|apply) kervan\.uz 127\.0\.0\.1\\:(\[0-9\]){4,5}/);
    }
    expect(siteHelperRules(policy)).toHaveLength(4);
  });

  test("never grants wildcard arguments for anything else", () => {
    expect(privilegedSteps(policy).every((s) => !s.args.some((a) => /[*?[]/.test(a)))).toBe(true);
  });

  test("passes visudo-style structure: one alias, one user line", () => {
    expect(text).toContain("Cmnd_Alias INCIDENTPULSE_RUNBOOKS = \\");
    expect(text).toMatch(/^incidentpulse-actions ALL=\(root\) NOPASSWD: INCIDENTPULSE_RUNBOOKS$/m);
  });
});
