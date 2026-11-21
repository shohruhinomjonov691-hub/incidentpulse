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

describe("production runbooks", () => {
  const scopes: Parameters<typeof loadRunbookRegistry>[0] = {
    kervan: {
      domains: ["kervan.uz"],
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
      www: true,
    },
  };
  const remote = loadRunbookRegistry(scopes, undefined, { remote: true });
  const local = loadRunbookRegistry(scopes);

  test("certbot_nginx_issue covers www when the scope says so", () => {
    const book = remote.resolve("kervan", {
      runbookId: "certbot_nginx_issue",
      params: { domain: "kervan.uz" },
    });
    expect(book.dryRun[0]?.args.slice(-4)).toEqual(["-d", "kervan.uz", "-d", "www.kervan.uz"]);
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

  test("nginx_site_proxy is medium risk, remote-only and offered only with discovered upstreams", () => {
    expect(remote.candidates("kervan").some((c) => c.id === "nginx_site_proxy")).toBe(false);
    const offered = remote.candidates("kervan", {
      upstreams: ["127.0.0.1:3000", "127.0.0.1:3001"],
    });
    const book = offered.find((c) => c.id === "nginx_site_proxy");
    expect(book).toMatchObject({
      risk: "medium",
      params: { domain: ["kervan.uz"], upstream: ["127.0.0.1:3000", "127.0.0.1:3001"] },
    });
    expect(
      local
        .candidates("kervan", { upstreams: ["127.0.0.1:3000"] })
        .some((c) => c.id === "nginx_site_proxy"),
    ).toBe(false);
  });

  test("nginx_site_proxy resolves with no local steps, and the upstream must be a loopback port from the list", () => {
    const dynamic = { upstreams: ["127.0.0.1:3000"] };
    const book = remote.resolve(
      "kervan",
      {
        runbookId: "nginx_site_proxy",
        params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
      },
      dynamic,
    );
    expect(book).toMatchObject({ remoteOnly: true, risk: "medium", run: [], dryRun: [] });
    for (const upstream of ["127.0.0.1:3001", "10.0.0.5:3000", "localhost:3000", "127.0.0.1:80"]) {
      expect(() =>
        remote.resolve(
          "kervan",
          { runbookId: "nginx_site_proxy", params: { domain: "kervan.uz", upstream } },
          dynamic,
        ),
      ).toThrow();
    }
    expect(() =>
      remote.resolve("kervan", {
        runbookId: "nginx_site_proxy",
        params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
      }),
    ).toThrow();
  });
});
