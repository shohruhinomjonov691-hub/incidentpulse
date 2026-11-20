import { describe, expect, test } from "vitest";
import { type DnsResolver, dnsLookup } from "../src/tools/dns.ts";

function resolver(overrides: Partial<DnsResolver>): DnsResolver {
  const notFound = () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
  return { resolve4: notFound, resolve6: notFound, resolveCname: notFound, ...overrides };
}

describe("dnsLookup", () => {
  test("returns A/AAAA/CNAME records", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({
        resolve4: async () => ["203.0.113.10"],
        resolve6: async () => ["2001:db8::1"],
      }),
    });
    expect(r).toMatchObject({ a: ["203.0.113.10"], aaaa: ["2001:db8::1"], cname: [] });
    expect(r.error).toBeUndefined();
  });

  test("a name that does not exist is reported with ENOTFOUND", async () => {
    const r = await dnsLookup("gone.kervan.uz", { timeoutMs: 1000, resolver: resolver({}) });
    expect(r).toMatchObject({ a: [], aaaa: [], cname: [], error: "ENOTFOUND" });
  });

  test("a real resolver failure wins over 'no data'", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({
        resolve4: () => Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" })),
      }),
    });
    expect(r.error).toBe("ESERVFAIL");
  });

  test("only IPv4 present is still a healthy answer", async () => {
    const r = await dnsLookup("kervan.uz", {
      timeoutMs: 1000,
      resolver: resolver({ resolve4: async () => ["203.0.113.10"] }),
    });
    expect(r.error).toBeUndefined();
  });
});
