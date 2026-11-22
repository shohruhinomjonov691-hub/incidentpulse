import { loadRunbookRegistry } from "@incidentpulse/mcp-actions";
import { describe, expect, test } from "vitest";
import { resolveRunbook } from "../src/commands.ts";
import { policy, policyNoWww } from "./helpers.ts";

/**
 * runbooks/*.yaml (what the orchestrator resolves and the sandbox runs) and the runner's own command
 * table must describe the same commands. If this fails, one of them was edited without the other.
 */
const registry = loadRunbookRegistry(
  {
    kervan: {
      domains: ["kervan.uz"],
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
      www: true,
    },
    codetrail: {
      domains: ["codetrail.example.com"],
      containers: ["codetrail-app"],
      compose: { name: "codetrail", file: "/srv/codetrail/compose.yaml" },
    },
  },
  undefined,
  { remote: true },
);

const cases: Array<["kervan" | "codetrail", string, Record<string, string>]> = [
  ["kervan", "certbot_renew", { domain: "kervan.uz" }],
  ["kervan", "certbot_nginx_issue", { domain: "kervan.uz" }],
  ["kervan", "nginx_reload", {}],
  ["kervan", "pm2_restart", { app: "KERVAN-REACT" }],
  ["codetrail", "docker_restart", { service: "codetrail-app" }],
  ["codetrail", "docker_compose_up", { project: "codetrail" }],
];

describe("runner command table matches runbooks/*.yaml", () => {
  test.each(cases)("%s %s", (project, runbookId, params) => {
    const yaml = registry.resolve(project, { runbookId, params });
    const runner = resolveRunbook(policy, project, runbookId, params);
    const asArgv = (steps: Array<{ program: string; args: string[] }>) =>
      steps.map((s) => [s.program, ...s.args]);
    const runnerArgv = (steps: Array<{ bin: string; args: string[] }>) =>
      steps.map((s) => [s.bin, ...s.args]);
    expect(runnerArgv(runner.dryRun)).toEqual(asArgv(yaml.dryRun));
    expect(runnerArgv(runner.run)).toEqual(asArgv(yaml.run));
    expect(runner.risk).toBe(yaml.risk);
  });

  test("nginx_site_proxy has no local steps in the registry and the same risk", () => {
    const yaml = registry.resolve(
      "kervan",
      {
        runbookId: "nginx_site_proxy",
        params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
      },
      { upstreams: ["127.0.0.1:3000"] },
    );
    const runner = resolveRunbook(policy, "kervan", "nginx_site_proxy", {
      domain: "kervan.uz",
      upstream: "127.0.0.1:3000",
    });
    expect(yaml.risk).toBe(runner.risk);
    expect(yaml.run).toEqual([]);
  });
});

describe("the same without www (Kervan's first rollout)", () => {
  const noWww = loadRunbookRegistry(
    {
      kervan: {
        domains: ["kervan.uz"],
        pm2: ["KERVAN", "KERVAN-REACT"],
        nginx: true,
        webroot: "/var/www/acme",
        www: false,
      },
    },
    undefined,
    { remote: true },
  );

  test("certbot_nginx_issue: -d kervan.uz only, identical in both tables", () => {
    const yaml = noWww.resolve("kervan", {
      runbookId: "certbot_nginx_issue",
      params: { domain: "kervan.uz" },
    });
    const runner = resolveRunbook(policyNoWww, "kervan", "certbot_nginx_issue", {
      domain: "kervan.uz",
    });
    expect(runner.dryRun.map((s) => [s.bin, ...s.args])).toEqual(
      yaml.dryRun.map((s) => [s.program, ...s.args]),
    );
    expect(runner.run.map((s) => [s.bin, ...s.args])).toEqual(
      yaml.run.map((s) => [s.program, ...s.args]),
    );
    expect(yaml.run[1]?.args).toEqual([
      "--nginx",
      "-d",
      "kervan.uz",
      "--non-interactive",
      "--redirect",
    ]);
  });
});
