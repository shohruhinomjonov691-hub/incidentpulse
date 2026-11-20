import { describe, expect, test } from "vitest";
import { isAllowedHost, isPlainHostname, parseAllowedHosts } from "../src/allowlist.ts";

describe("allowlist", () => {
  const allowed = parseAllowedHosts(" Kervan.uz, 127.0.0.1 ,");

  test("parses, trims and lowercases", () => {
    expect(allowed).toEqual(["kervan.uz", "127.0.0.1"]);
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
