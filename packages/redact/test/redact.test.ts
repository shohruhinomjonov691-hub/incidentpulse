import { describe, expect, test } from "vitest";
import { collectSecrets, createRedactor, describeError, redactDeep } from "../src/index.ts";

const fakeOpenAiKey = `sk-proj-${"a1B2c3D4".repeat(5)}`;
const fakeTelegramToken = `123456789:${"AbCdEfGhIj".repeat(3)}_x`;

describe("createRedactor", () => {
  const redact = createRedactor({ secrets: ["super-secret-value-123"] });

  test("masks exact secret values anywhere in the text", () => {
    expect(redact("x super-secret-value-123 y")).toBe("x [REDACTED] y");
  });

  test.each([
    ["openai key", `key ${fakeOpenAiKey} end`, fakeOpenAiKey],
    ["telegram token", `bot ${fakeTelegramToken}`, fakeTelegramToken],
    [
      "github token",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
    ["bearer token", "Authorization: Bearer abcdef1234567890xyz", "abcdef1234567890xyz"],
    ["url password", "postgres://user:hunter2pass@db:5432/x", "hunter2pass"],
    ["env style", "OPENAI_API_KEY=whatever-123", "whatever-123"],
    ["json style", '{"password": "p4ssw0rd!"}', "p4ssw0rd!"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "eyJhbGciOiJIUzI1NiJ9"],
    ["email", "contact me at someone@example.com", "someone@example.com"],
    ["aws key", "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ])("masks %s", (_name, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  test("masks PEM private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END PRIVATE KEY-----";
    expect(redact(`before ${pem} after`)).toBe("before [REDACTED:private-key] after");
  });

  test("keeps harmless diagnostic text intact", () => {
    const text =
      "notAfter=2026-11-18T00:00:00.000Z issuer=R11 sans=kervan.uz,www.kervan.uz status=200 latency=123ms";
    expect(redact(text)).toBe(text);
  });

  test("ignores very short 'secrets' to avoid masking ordinary words", () => {
    expect(createRedactor({ secrets: ["abc"] })("abc def")).toBe("abc def");
  });
});

describe("redactDeep", () => {
  test("redacts nested strings but not keys or numbers", () => {
    const redact = createRedactor({ secrets: ["super-secret-value-123"] });
    expect(
      redactDeep(
        { a: ["x super-secret-value-123"], n: 5, nested: { s: "super-secret-value-123" } },
        redact,
      ),
    ).toEqual({ a: ["x [REDACTED]"], n: 5, nested: { s: "[REDACTED]" } });
  });
});

describe("collectSecrets", () => {
  test("collects secret-named env values and URL passwords", () => {
    const secrets = collectSecrets({
      OPENAI_API_KEY: "k1",
      TELEGRAM_BOT_TOKEN: "t1",
      DATABASE_URL: "postgres://u:pw%21@h/db",
      INTAKE_PORT: "8787",
      EMPTY_SECRET: undefined,
    });
    expect(secrets).toEqual(expect.arrayContaining(["k1", "t1", "pw!"]));
    expect(secrets).not.toContain("8787");
  });
});

describe("describeError", () => {
  test("never includes a stack and redacts the message", () => {
    const redact = createRedactor({ secrets: ["super-secret-value-123"] });
    const text = describeError(new Error("failed with super-secret-value-123"), redact);
    expect(text).toBe("Error: failed with [REDACTED]");
  });
});
