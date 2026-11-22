import { describe, expect, test } from "vitest";
import {
  parseCertbotCertificates,
  parseNginxServers,
  parsePm2Jlist,
  parsePm2Logs,
  parsePsTree,
  parseSs,
  portsPerApp,
  scrub,
} from "../src/parse.ts";
import { CERTS, NGINX_DUMP, PM2_JLIST, PS_OUTPUT, SS_OUTPUT } from "./helpers.ts";

describe("pm2", () => {
  test("keeps only allowlisted apps and skips a banner before the JSON", () => {
    const apps = parsePm2Jlist(`[PM2] Spawning PM2 daemon\n${PM2_JLIST}`, [
      "KERVAN",
      "KERVAN-REACT",
    ]);
    expect(apps.map((a) => a.name)).toEqual(["KERVAN", "KERVAN-REACT"]);
    expect(apps[0]).toMatchObject({ status: "online", restarts: 2, pid: 100 });
  });
  test("output without JSON is an error, not an empty success", () => {
    expect(() => parsePm2Jlist("pm2: command failed", ["KERVAN"])).toThrow("BAD_OUTPUT");
  });
  test("logs: last N lines, headers dropped, secrets masked", () => {
    const lines = parsePm2Logs(
      "[TAILING] Tailing last 200 lines\n/root/.pm2/logs/x-out.log last 200 lines:\nok\nAuthorization: Bearer abcdefghijklmnop\n",
      2,
    );
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("abcdefghijklmnop");
  });
});

describe("ports", () => {
  test("maps listening ports to the pm2 app that owns them, children included", () => {
    const apps = parsePm2Jlist(PM2_JLIST, ["KERVAN", "KERVAN-REACT"]);
    const result = portsPerApp(apps, parseSs(SS_OUTPUT), parsePsTree(PS_OUTPUT));
    expect(result).toEqual([
      { app: "KERVAN", pid: 100, ports: [3000] },
      { app: "KERVAN-REACT", pid: 200, ports: [3001] },
    ]);
  });
  test("a stopped app owns nothing", () => {
    const apps = parsePm2Jlist(
      JSON.stringify([{ name: "KERVAN", pid: 0, pm2_env: { status: "stopped" } }]),
      ["KERVAN"],
    );
    expect(portsPerApp(apps, parseSs(SS_OUTPUT), parsePsTree(PS_OUTPUT))[0]?.ports).toEqual([]);
  });
  test("ignores sockets that are not reachable through 127.0.0.1", () => {
    const [only] = parseSs('LISTEN 0 1 [::1]:3000 [::]:* users:(("node",pid=100,fd=1))');
    expect(only).toMatchObject({ address: "[::1]", port: 3000 });
    const apps = parsePm2Jlist(PM2_JLIST, ["KERVAN"]);
    expect(portsPerApp(apps, [only as never], parsePsTree(PS_OUTPUT))[0]?.ports).toEqual([]);
  });
});

describe("nginx -T", () => {
  const servers = parseNginxServers(NGINX_DUMP);
  test("finds every server block, ignoring comments and the nginx: preamble", () => {
    expect(servers.map((s) => s.names)).toEqual([["_"], ["other.example", "www.other.example"]]);
    expect(servers.flatMap((s) => s.names)).not.toContain("commented.example");
  });
  test("reads listen, ssl, default_server and proxy_pass", () => {
    expect(servers[0]).toMatchObject({ defaultServer: true, ssl: false });
    expect(servers[1]).toMatchObject({ ssl: true, proxyPass: ["http://127.0.0.1:4000"] });
  });
});

describe("certbot certificates", () => {
  test("parses names, domains and expiry, and never returns key paths", () => {
    const [cert] = parseCertbotCertificates(CERTS);
    expect(cert).toMatchObject({
      name: "other.example",
      domains: ["other.example", "www.other.example"],
      daysRemaining: 59,
      valid: true,
    });
    expect(JSON.stringify(cert)).not.toContain("privkey");
  });
  test("an expired certificate is invalid", () => {
    const [cert] = parseCertbotCertificates(
      "  Certificate Name: a.example\n    Domains: a.example\n    Expiry Date: 2020-01-01 00:00:00+00:00 (INVALID: EXPIRED)\n",
    );
    expect(cert).toMatchObject({ valid: false });
  });
});

test("scrub masks passwords and private keys", () => {
  expect(scrub("password=hunter2hunter2 ok")).toContain("[REDACTED]");
  expect(scrub("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe("[REDACTED]");
});

describe("redaction happens before truncation (M9)", () => {
  const KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
    "MBEFA1UEAwwObG9jYWxob3N0LWNlcnQwHhcNMjQwMTAxMDAwMDAwWhcNMzQwMTAx",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  test("a multi-line private key in pm2 logs is removed whole, not line by line", () => {
    const lines = parsePm2Logs(`start\n${KEY}\nend\n`, 50);
    const text = lines.join("\n");
    expect(text).not.toContain("MIIEvQIBADAN");
    expect(text).not.toContain("MBEFA1UEAwwO");
    expect(text).toContain("[REDACTED]");
    expect(lines[0]).toBe("start");
    expect(lines.at(-1)).toBe("end");
  });

  test("a secret that would straddle the old cut leaves no fragment behind", () => {
    // Cutting first (400 chars) keeps only "Bearer abcdefgh..." (fragment survives when < 8 chars); redacting first removes it.
    const line = `${"x".repeat(370)} Bearer abcdefghijklmnopqrstuvwxyz0123456789 tail`;
    const [out] = parsePm2Logs(line, 5);
    expect(out).not.toContain("Bearer abc");
    expect(out).not.toContain("abcdefgh");
    expect(out).toContain("Bearer [REDACTED]");
  });
});
