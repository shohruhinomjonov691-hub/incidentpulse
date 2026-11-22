import { describe, expect, test } from "vitest";
import { type RunResult, renderVhost, type SiteEnv, siteProxy } from "../src/nginx-site.ts";
import { NGINX_DUMP, NGINX_DUMP_CONF_D, policy, policyNoWww } from "./helpers.ts";

const NGINX = "/usr/sbin/nginx";
const DUMP_WITH_SITE = `${NGINX_DUMP}\nhttp2 {}\n`;

function fakeHost(
  over: Partial<{
    tcp: boolean;
    nginxT: RunResult[];
    reload: RunResult;
    status: number | undefined;
    files: string[];
    dumpAfter: string;
    tar: RunResult;
  }> = {},
) {
  const files = new Set(over.files ?? []);
  const log: string[] = [];
  const tests = [...(over.nginxT ?? [{ code: 0, stdout: "", stderr: "ok" }])];
  let dumps = 0;
  const env: SiteEnv = {
    async run(file, args) {
      const line = `${file} ${args.join(" ")}`;
      log.push(line);
      if (file === NGINX && args[0] === "-T") {
        dumps += 1;
        const dump =
          dumps === 1
            ? NGINX_DUMP
            : (over.dumpAfter ??
              `${NGINX_DUMP}\nserver { listen 80; server_name kervan.uz www.kervan.uz; }`);
        return { code: 0, stdout: dump, stderr: "" };
      }
      if (file === NGINX && args[0] === "-t")
        return tests.length > 1 ? (tests.shift() as RunResult) : (tests[0] as RunResult);
      if (file === "/usr/bin/systemctl") return over.reload ?? { code: 0, stdout: "", stderr: "" };
      if (file === "/usr/bin/tar")
        return args[0] === "-czf"
          ? (over.tar ?? { code: 0, stdout: "", stderr: "" })
          : { code: 0, stdout: "", stderr: "" };
      return { code: 127, stdout: "", stderr: `unexpected ${line}` };
    },
    exists: (p) => files.has(p),
    write: (p) => void files.add(p),
    symlink: (_t, p) => void files.add(p),
    remove: (p) => {
      if (!files.delete(p)) throw new Error("ENOENT");
    },
    mkdirp: () => undefined,
    tcpOpen: async () => over.tcp ?? true,
    httpStatus: async () => ("status" in over ? over.status : 200),
    now: () => new Date("2026-11-21T10:00:00Z"),
  };
  return { env, files, log };
}

const req = { mode: "apply", domain: "kervan.uz", upstream: "127.0.0.1:3000" } as const;

describe("nginx_site_proxy helper", () => {
  test("template: HTTP only, ACME webroot, proxy to the upstream, www included", () => {
    const text = renderVhost({
      domain: "kervan.uz",
      www: true,
      upstream: "127.0.0.1:3000",
      webroot: "/var/www/acme",
    });
    expect(text).toContain("server_name kervan.uz www.kervan.uz;");
    expect(text).toContain("proxy_pass http://127.0.0.1:3000;");
    expect(text).toContain("root /var/www/acme;");
    expect(text).toContain("managed-by: incidentpulse");
    expect(text).not.toContain("ssl");
  });

  test("apply: backs up /etc/nginx first, writes, tests, reloads and verifies", async () => {
    const { env, files, log } = fakeHost();
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(
      "backup=/var/backups/incidentpulse/nginx-20261121T100000Z.tar.gz",
    );
    expect(files).toContain("/etc/nginx/sites-enabled/kervan.uz.conf");
    const order = log.map((l) => l.split(" ").slice(0, 2).join(" "));
    expect(order.findIndex((l) => l.includes("tar -czf"))).toBeLessThan(
      order.findIndex((l) => l.includes("systemctl reload")),
    );
  });

  test("check changes nothing", async () => {
    const { env, files } = fakeHost();
    const result = await siteProxy(env, policy, { ...req, mode: "check" });
    expect(result.ok).toBe(true);
    expect(files.size).toBe(0);
  });

  test("nginx -t failure rolls back: files removed and nginx reloaded only after a good test", async () => {
    const bad: RunResult = { code: 1, stdout: "", stderr: "nginx: [emerg] unknown directive" };
    const good: RunResult = { code: 0, stdout: "", stderr: "ok" };
    const { env, files, log } = fakeHost({ nginxT: [bad, good] });
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ROLLED BACK (nginx -t failed");
    expect(files.size).toBe(0);
    expect(log.filter((l) => l.includes("systemctl reload"))).toHaveLength(1); // the rollback reload
  });

  test("reload failure rolls back", async () => {
    const { env, files } = fakeHost({ reload: { code: 1, stdout: "", stderr: "reload failed" } });
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ROLLED BACK (reload failed");
    expect(files.size).toBe(0);
  });

  test("a 502 through the new vhost rolls back", async () => {
    const { env, files } = fakeHost({ status: 502 });
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("returned 502");
    expect(files.size).toBe(0);
  });

  test("a vhost that is not part of the active config rolls back", async () => {
    const { env } = fakeHost({ dumpAfter: NGINX_DUMP });
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not part of the active configuration");
  });

  test("a failed backup aborts before any change", async () => {
    const { env, files } = fakeHost({ tar: { code: 2, stdout: "", stderr: "disk full" } });
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("nothing changed");
    expect(files.size).toBe(0);
  });

  test.each([
    ["nothing listens on the port", { tcp: false }, req],
    ["a conf file already exists", { files: ["/etc/nginx/sites-available/kervan.uz.conf"] }, req],
    ["a domain outside the policy", {}, { ...req, domain: "evil.example" }],
    ["a domain of a project without nginx", {}, { ...req, domain: "codetrail.example.com" }],
    ["a non-loopback upstream", {}, { ...req, upstream: "10.0.0.1:3000" }],
  ])("refuses when %s", async (_name, over, request) => {
    const { env, files } = fakeHost(over as never);
    const result = await siteProxy(env, policy, request as never);
    expect(result.ok).toBe(false);
    expect(files.size).toBe(over && "files" in over ? 1 : 0);
  });

  test("refuses when a server block for the domain already exists", async () => {
    const { env } = fakeHost();
    const original = env.run;
    env.run = async (file, args) =>
      file === NGINX && args[0] === "-T"
        ? {
            code: 0,
            stdout: `${DUMP_WITH_SITE}\nhttp { server { listen 80; server_name www.kervan.uz; } }`,
            stderr: "",
          }
        : original(file, args);
    const result = await siteProxy(env, policy, req);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("already exists");
  });

  test.each([
    ["without www", policyNoWww],
    ["with www in the policy", policy],
  ])(
    "refuses in both modes when conf.d/kervan.conf already names the domain (%s)",
    async (_n, using) => {
      for (const mode of ["check", "apply"] as const) {
        const { env, files, log } = fakeHost();
        const original = env.run;
        env.run = async (file, args) =>
          file === NGINX && args[0] === "-T"
            ? { code: 0, stdout: NGINX_DUMP_CONF_D, stderr: "" }
            : original(file, args);
        const result = await siteProxy(env, using, { ...req, mode });
        expect(result.ok).toBe(false);
        expect(result.output).toContain("already exists");
        // Strict: nothing was written, no backup, no test, no reload; only the read of nginx -T.
        expect(files.size).toBe(0);
        expect(log.some((l) => /tar |systemctl|nginx -t/.test(l))).toBe(false);
      }
    },
  );
});
