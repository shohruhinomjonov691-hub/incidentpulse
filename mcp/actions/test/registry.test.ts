import { describe, expect, test } from "vitest";
import { loadRunbookRegistry } from "../src/index.ts";

const registry = loadRunbookRegistry({
  gotrip: {
    domains: ["local.example:8443"],
    containers: ["local-app"],
    pm2: ["local-api"],
    compose: { name: "local-stack", file: "/srv/local/compose.yaml" },
    nginx: true,
    webroot: "/srv/www/acme",
  },
});

describe("runbook registry", () => {
  test("offers six configured books, with fixed programs and allowlisted substitutions", () => {
    expect(registry.candidates("gotrip")).toHaveLength(6);
    const book = registry.resolve("gotrip", {
      runbookId: "certbot_nginx_issue",
      params: { domain: "local.example" },
    });
    expect(book.risk).toBe("medium");
    expect(book.prerequisite).toBe("missing_certificate_or_vhost");
    expect(book.dryRun[0]?.args.slice(0, 2)).toEqual(["certonly", "--dry-run"]);
    expect(book.run[0]).toMatchObject({
      program: "certbot",
      args: expect.arrayContaining(["--nginx", "-d", "local.example"]),
    });
    expect(
      registry.resolve("gotrip", {
        runbookId: "docker_compose_up",
        params: { project: "local-stack" },
      }).run[0]?.args,
    ).toEqual(["compose", "-f", "/srv/local/compose.yaml", "-p", "local-stack", "up", "-d"]);
  });

  test.each([
    { runbookId: "shell", params: {} },
    { runbookId: "docker_restart", params: { service: "unlisted-app" } },
    { runbookId: "docker_restart", params: { service: "--help" } },
    { runbookId: "nginx_reload", params: { flags: "unexpected" } },
    { runbookId: "certbot_nginx_issue", params: { domain: "other.example" } },
  ])("denies an unknown runbook, unexpected keys or out-of-scope parameter values", (choice) => {
    expect(() => registry.resolve("gotrip", choice)).toThrow();
  });
});
