import type { AddressInfo } from "node:net";
import tls, { type PeerCertificate } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { summarizeCertificate, tlsInspect } from "../src/tools/tls.ts";
import { makeSelfSignedCert } from "./helpers.ts";

const NOW = new Date("2026-11-21T00:00:00Z");

function fakeCert(overrides: Partial<PeerCertificate> = {}): PeerCertificate {
  return {
    subject: { CN: "kervan.uz" },
    issuer: { O: "Let's Encrypt", CN: "R11" },
    subjectaltname: "DNS:kervan.uz, DNS:www.kervan.uz",
    valid_from: "Aug 20 00:00:00 2026 GMT",
    valid_to: "Nov 18 00:00:00 2026 GMT",
    fingerprint256: "AA:BB",
    ...overrides,
  } as PeerCertificate;
}

const base = {
  host: "kervan.uz",
  port: 443,
  authorized: false,
  authorizationError: "CERT_HAS_EXPIRED" as string | undefined,
  protocol: "TLSv1.3",
  now: NOW,
  latencyMs: 12,
};

describe("summarizeCertificate", () => {
  test("flags an expired certificate (the SPEC §6 scenario)", () => {
    const r = summarizeCertificate({ ...base, cert: fakeCert() });
    expect(r).toMatchObject({
      connected: true,
      chainValid: false,
      validationError: "CERT_HAS_EXPIRED",
      expired: true,
      notYetValid: false,
      hostnameMatch: true,
      notAfter: "2026-11-18T00:00:00.000Z",
      daysRemaining: -3,
      issuer: "Let's Encrypt / R11",
      sans: ["kervan.uz", "www.kervan.uz"],
    });
  });

  test("healthy certificate", () => {
    const r = summarizeCertificate({
      ...base,
      authorized: true,
      authorizationError: undefined,
      cert: fakeCert({ valid_to: "Feb 18 00:00:00 2027 GMT" }),
    });
    expect(r).toMatchObject({ chainValid: true, expired: false, daysRemaining: 89 });
    expect(r.validationError).toBeUndefined();
  });

  test("detects a hostname mismatch", () => {
    const r = summarizeCertificate({ ...base, host: "other.example", cert: fakeCert() });
    expect(r.hostnameMatch).toBe(false);
  });

  test("handles missing optional fields without throwing", () => {
    const r = summarizeCertificate({
      ...base,
      cert: { valid_from: "", valid_to: "", subject: {}, issuer: {} } as unknown as PeerCertificate,
    });
    expect(r.notAfter).toBeUndefined();
    expect(r.expired).toBeUndefined();
  });
});

describe("tlsInspect against a local server", () => {
  let server: tls.Server;
  let port: number;

  beforeAll(async () => {
    const { key, cert } = makeSelfSignedCert();
    server = tls.createServer({ key, cert }, (s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("reports a self-signed chain as invalid but still returns the certificate", async () => {
    const r = await tlsInspect("127.0.0.1", { timeoutMs: 3000, port });
    expect(r.connected).toBe(true);
    expect(r.chainValid).toBe(false);
    expect(r.validationError).toMatch(/SELF_SIGNED|UNABLE_TO/);
    expect(r.hostnameMatch).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.sans).toEqual(expect.arrayContaining(["localhost"]));
  });

  test("connection refused is data, not an exception", async () => {
    const r = await tlsInspect("127.0.0.1", { timeoutMs: 1000, port: 1 });
    expect(r).toMatchObject({ connected: false, error: "ECONNREFUSED" });
  });

  test("times out on a server that never answers the handshake", async () => {
    const { createServer } = await import("node:net");
    const sockets = new Set<import("node:net").Socket>();
    const silent = createServer((s) => sockets.add(s));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const silentPort = (silent.address() as AddressInfo).port;
    const r = await tlsInspect("127.0.0.1", { timeoutMs: 300, port: silentPort });
    expect(r).toMatchObject({ connected: false, error: "ETIMEDOUT" });
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => silent.close(() => res()));
  });
});
