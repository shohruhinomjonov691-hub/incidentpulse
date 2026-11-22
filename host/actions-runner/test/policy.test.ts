import { describe, expect, test } from "vitest";
import { allCoveredDomains, PolicyError, parsePolicy } from "../src/policy.ts";
import { policy } from "./helpers.ts";

describe("policy", () => {
  test("www is covered only where enabled", () => {
    expect(allCoveredDomains(policy)).toEqual([
      "kervan.uz",
      "www.kervan.uz",
      "codetrail.example.com",
    ]);
  });
  test.each([
    [{ projects: { Bad_Id: {} } }],
    [{ projects: { a: { domains: ["not a domain"] } } }],
    [{ projects: { a: { domains: ["a.example:8443"] } } }],
    [{ projects: { a: { pm2: ["--help; rm"] } } }],
    [{ projects: { a: { webroot: "relative/path" } } }],
    [{ projects: { a: { webroot: "/var/../etc" } } }],
    [{ projects: { a: { surprise: true } } }],
    [{ projects: {}, bins: { certbot: "certbot" } }],
    [{ projects: {}, bins: { rm: "/bin/rm" } }],
    [{ projects: {}, upstreamPortMin: 80 }],
    [{ projects: [] }],
    [{ projects: {}, publicIps: ["not-an-ip"] }],
    [{ projects: {}, publicIps: ["2001:db8::1"] }],
    [{ projects: {}, publicIps: "203.0.113.10" }],
  ])("rejects an invalid policy %#", (input) => {
    expect(() => parsePolicy(input)).toThrow(PolicyError);
  });

  test("publicIps is optional, deduplicated and sorted", () => {
    expect(parsePolicy({ projects: {} }).publicIps).toBeUndefined();
    expect(
      parsePolicy({ projects: {}, publicIps: ["203.0.113.10", "198.51.100.7", "203.0.113.10"] })
        .publicIps,
    ).toEqual(["198.51.100.7", "203.0.113.10"]);
  });
});
