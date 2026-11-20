import { describe, expect, test } from "vitest";
import { type DnsResolver, dnsLookup } from "../src/tools/dns.ts";

const fail = (code: string) => () => Promise.reject(Object.assign(new Error("x"), { code }));

function resolver(overrides: Partial<DnsResolver>): DnsResolver {
  return { lookup: fail("ENOTFOUND"), resolveCname: fail("ENODATA"), ...overrides };
}

describe("dnsLookup", () => {
  test("splits lookup results into A and AAAA and returns CNAMEs", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({
        lookup: async () => [
          { address: "203.0.113.10", family: 4 },
          { address: "2001:db8::1", family: 6 },
        ],
        resolveCname: async () => ["edge.example.net"],
      }),
    });
    expect(r).toMatchObject({
      a: ["203.0.113.10"],
      aaaa: ["2001:db8::1"],
      cname: ["edge.example.net"],
    });
    expect(r.error).toBeUndefined();
  });

  test("a name that does not exist is reported with ENOTFOUND", async () => {
    const r = await dnsLookup("gone.kervan.uz", { timeoutMs: 1000, resolver: resolver({}) });
    expect(r).toMatchObject({ a: [], aaaa: [], cname: [], error: "ENOTFOUND" });
  });

  test("a real resolver failure wins over 'no data'", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({ lookup: fail("ESERVFAIL") }),
    });
    expect(r.error).toBe("ESERVFAIL");
  });

  test("a hanging resolver is cut off by the deadline", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 100,
      resolver: resolver({ lookup: () => new Promise(() => undefined) }),
    });
    expect(r.error).toBe("ETIMEOUT");
  });

  test("only IPv4 present is still a healthy answer", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({ lookup: async () => [{ address: "203.0.113.10", family: 4 }] }),
    });
    expect(r.error).toBeUndefined();
  });

  test("the default system resolver honours getaddrinfo (localhost, *.localhost)", async () => {
    const r = await dnsLookup("localhost", { timeoutMs: 2000 });
    expect([...r.a, ...r.aaaa]).toEqual(
      expect.arrayContaining([expect.stringMatching(/127\.0\.0\.1|::1/)]),
    );
  });
});
