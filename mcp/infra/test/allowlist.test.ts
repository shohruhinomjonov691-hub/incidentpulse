import { describe, expect, test } from "vitest";
import {
  isAllowedContainer,
  isAllowedHost,
  isAllowedTarget,
  isPlainHostname,
  parseAllowedContainers,
  parseAllowedHosts,
} from "../src/allowlist.ts";

describe("host allowlist", () => {
  const allowed = parseAllowedHosts(" Kervan.uz, 127.0.0.1 ,a.localhost:18443,");

  test("parses, trims and lowercases (ports are kept)", () => {
    expect(allowed).toEqual(["kervan.uz", "127.0.0.1", "a.localhost:18443"]);
  });

  test.each([
    ["kervan.uz", true],
    ["KERVAN.UZ.", true],
    ["www.kervan.uz", true],
    ["a.b.kervan.uz", true],
    ["evilkervan.uz", false],
    ["kervan.uz.evil.com", false],
    ["example.com", false],
    ["127.0.0.1", true],
    ["127.0.0.2", false],
    ["169.254.169.254", false],
    ["a.localhost", true], // DNS has no port: any entry for the host counts
    ["", false],
  ])("isAllowedHost(%s) = %s", (host, expected) => {
    expect(isAllowedHost(host, allowed)).toBe(expected);
  });

  test("an IP in the allowlist does not allow its 'subdomains'", () => {
    expect(isAllowedHost("x.127.0.0.1", allowed)).toBe(false);
  });

  test("empty allowlist allows nothing", () => {
    expect(isAllowedHost("kervan.uz", [])).toBe(false);
  });

  test.each([
    ["kervan.uz", 443, true],
    ["kervan.uz", 80, true],
    ["www.kervan.uz", 443, true],
    ["kervan.uz", 22, false], // an allowed host is not a port scanner
    ["kervan.uz", 8080, false],
    ["a.localhost", 18443, true], // pinned port
    ["a.localhost", 443, false], // pinned entry does NOT also open 443
    ["a.localhost", 18444, false],
    ["b.a.localhost", 18443, true],
    ["example.com", 443, false],
    ["127.0.0.1", 443, true],
  ])("isAllowedTarget(%s, %i) = %s", (host, port, expected) => {
    expect(isAllowedTarget(host, port, allowed)).toBe(expected);
  });

  test.each([
    ["kervan.uz", true],
    ["127.0.0.1", true],
    ["https://kervan.uz", false],
    ["kervan.uz:443", false],
    ["kervan.uz/path", false],
    ["user@kervan.uz", false],
    ["a b", false],
  ])("isPlainHostname(%s) = %s", (host, expected) => {
    expect(isPlainHostname(host)).toBe(expected);
  });
});

describe("container allowlist", () => {
  const allowed = parseAllowedContainers(" ipsb-a- , web ,");

  test("parses entries", () => {
    expect(allowed).toEqual(["ipsb-a-", "web"]);
  });

  test.each([
    ["ipsb-a-nginx", true],
    ["ipsb-a-app", true],
    ["web", true],
    ["web-2", true], // prefix semantics
    ["ipsb-b-app", false],
    ["incidentpulse-postgres-1", false],
    ["--all", false], // looks like a flag
    ["a b", false],
    ["../etc", false],
    ["", false],
  ])("isAllowedContainer(%s) = %s", (name, expected) => {
    expect(isAllowedContainer(name, allowed)).toBe(expected);
  });

  test("an empty entry never matches everything", () => {
    expect(isAllowedContainer("anything", [""])).toBe(false);
  });
});
