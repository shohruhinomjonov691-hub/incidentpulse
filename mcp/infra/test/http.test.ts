import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { createSecureContext } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpProbe } from "../src/tools/http.ts";
import { allowLoopbackFixture, closedPort, makeSelfSignedCert, mockProbeDns } from "./helpers.ts";

let server: Server;
let base: string;
let seenHosts: string[];

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    seenHosts.push(req.headers.host ?? "");
    switch (req.url) {
      case "/ok":
        res.writeHead(200).end("hello");
        break;
      case "/hop":
        res.writeHead(302, { location: "/ok" }).end();
        break;
      case "/out":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
        break;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        break;
      case "/boom":
        res.writeHead(502).end();
        break;
      case "/hang":
        break; // never respond
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // Ports must be allowlisted explicitly (an allowed host is not a port scanner).
  opts = () => ({ timeoutMs: 1500, allowedHosts: [`127.0.0.1:${port}`] });
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

let opts: () => { timeoutMs: number; allowedHosts: string[] };

describe("httpProbe", () => {
  beforeEach(() => {
    allowLoopbackFixture();
    seenHosts = [];
  });
  afterEach(() => vi.restoreAllMocks());

  test("200 without redirects", async () => {
    const r = await httpProbe(`${base}/ok`, opts());
    expect(r).toMatchObject({ completed: true, status: 200, redirects: [] });
  });

  test("records the redirect chain inside the allowlist", async () => {
    const r = await httpProbe(`${base}/hop`, opts());
    expect(r.status).toBe(200);
    expect(r.redirects).toHaveLength(1);
    expect(r.redirects[0]).toMatchObject({ status: 302, location: "/ok" });
    expect(r.finalUrl).toBe(`${base}/ok`);
  });

  test("uses the checked DNS address, preserves Host and rechecks DNS for a same-host redirect", async () => {
    const port = new URL(base).port;
    let calls = 0;
    const dns = mockProbeDns(() => [
      ++calls === 1 ? { address: "127.0.0.1", family: 4 } : { address: "10.0.0.5", family: 4 },
    ]);
    const host = `www.kervan.uz:${port}`;
    const result = await httpProbe(`http://${host}/hop`, {
      timeoutMs: 1500,
      allowedHosts: [`kervan.uz:${port}`],
    });
    expect(result).toMatchObject({ completed: false, error: "IP_NOT_ALLOWED" });
    expect(result.redirects).toHaveLength(1);
    expect(dns).toHaveBeenCalledTimes(2);
    expect(seenHosts).toEqual([host]);
  });

  test("does NOT follow a redirect to a host outside the allowlist (SSRF guard)", async () => {
    const r = await httpProbe(`${base}/out`, opts());
    expect(r.completed).toBe(false);
    expect(r.error).toBe("HOST_NOT_ALLOWED");
    expect(r.blockedRedirect).toBe("http://169.254.169.254");
  });

  test("refuses a start URL outside the allowlist without any request", async () => {
    const r = await httpProbe("http://example.com/", opts());
    expect(r).toMatchObject({ completed: false, error: "HOST_NOT_ALLOWED" });
  });

  test("stops redirect loops", async () => {
    const r = await httpProbe(`${base}/loop`, opts());
    expect(r.error).toBe("TOO_MANY_REDIRECTS");
  });

  test("5xx is reported as a completed response", async () => {
    expect((await httpProbe(`${base}/boom`, opts())).status).toBe(502);
  });

  test("times out", async () => {
    const r = await httpProbe(`${base}/hang`, { ...opts(), timeoutMs: 250 });
    expect(r).toMatchObject({ completed: false, error: "ETIMEDOUT" });
  });

  test("connection refused", async () => {
    const closed = await closedPort();
    const r = await httpProbe(`http://127.0.0.1:${closed}/`, {
      timeoutMs: 1500,
      allowedHosts: [`127.0.0.1:${closed}`],
    });
    expect(r).toMatchObject({ completed: false, error: "ECONNREFUSED" });
  });

  test.each(["ftp://127.0.0.1/", "not a url", "http://user:pw@127.0.0.1/"])(
    "rejects %s",
    async (u) => {
      const r = await httpProbe(u, opts());
      expect(r.completed).toBe(false);
      expect(r.error).toMatch(/INVALID_URL|UNSUPPORTED_URL/);
    },
  );

  test("surfaces a TLS error code for a self-signed HTTPS endpoint", async () => {
    const { key, cert } = makeSelfSignedCert();
    const seenSni: string[] = [];
    const https = createHttpsServer(
      {
        key,
        cert,
        SNICallback(host, callback) {
          seenSni.push(host);
          callback(null, createSecureContext({ key, cert }));
        },
      },
      (_q, res) => res.writeHead(200).end(),
    );
    await new Promise<void>((r) => https.listen(0, "127.0.0.1", r));
    const port = (https.address() as AddressInfo).port;
    const dns = mockProbeDns(() => [{ address: "127.0.0.1", family: 4 }]);
    const r = await httpProbe(`https://localhost:${port}/`, {
      timeoutMs: 1500,
      allowedHosts: [`localhost:${port}`],
    });
    await new Promise<void>((res) => https.close(() => res()));
    expect(r.completed).toBe(false);
    expect(r.certErrorCode).toMatch(/SELF_SIGNED|UNABLE_TO/);
    expect(dns).toHaveBeenCalledOnce();
    expect(seenSni).toEqual(["localhost"]);
  });
});

test.each([
  "127.0.0.1",
  "127.1",
  "10.0.0.1",
  "172.31.255.254",
  "192.168.1.1",
  "169.254.169.254",
  "100.100.100.200",
  "[::1]",
  "[fd00:ec2::254]",
  "[fc00::1]",
  "[fe80::1]",
  "[::ffff:7f00:1]",
  "[::ffff:192.168.1.1]",
])("rejects blocked IP %s even when explicitly allowlisted", async (host) => {
  const url = new URL(`http://${host}/`);
  expect(
    await httpProbe(url.href, { allowedHosts: [url.hostname], timeoutMs: 1000 }),
  ).toMatchObject({
    completed: false,
    error: "IP_NOT_ALLOWED",
  });
});

test("rejects a mixed public/private DNS answer set for an allowlisted subdomain", async () => {
  const dns = mockProbeDns(() => [
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:169.254.169.254", family: 6 },
  ]);
  try {
    expect(
      await httpProbe("https://api.gotrips.cloud/", {
        allowedHosts: ["gotrips.cloud"],
        timeoutMs: 1000,
      }),
    ).toMatchObject({ completed: false, error: "IP_NOT_ALLOWED" });
    expect(dns).toHaveBeenCalledOnce();
  } finally {
    dns.mockRestore();
  }
});
