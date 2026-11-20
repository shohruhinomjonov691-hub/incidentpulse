import { describe, expect, test } from "vitest";
import { sign, verifySignature } from "../src/signature.ts";

const secret = "k".repeat(64);
const body = Buffer.from('{"project":"kervan"}');
const NOW = 1_800_000_000_000;
const ts = String(NOW / 1000);

const verify = (over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    secret,
    timestamp: ts,
    signature: sign(secret, ts, body),
    rawBody: body,
    nowMs: NOW,
    ...over,
  });

describe("webhook signature", () => {
  test("accepts a correct signature", () => {
    expect(verify()).toEqual({ ok: true });
  });

  test("rejects missing headers", () => {
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: "missing_headers" });
  });

  test.each(["abc", "-5", "1.5", "99999999999999"])("rejects malformed timestamp %s", (bad) => {
    expect(verify({ timestamp: bad })).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  test("accepts exactly at the 5-minute boundary, rejects beyond (past and future)", () => {
    const at = (offsetSec: number) => {
      const t = String(NOW / 1000 + offsetSec);
      return verify({ timestamp: t, signature: sign(secret, t, body) });
    };
    expect(at(-300).ok).toBe(true);
    expect(at(300).ok).toBe(true);
    expect(at(-301)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(at(301)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  test("rejects a tampered body", () => {
    expect(verify({ rawBody: Buffer.from('{"project":"gotrip"}') })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("rejects a signature made with another secret", () => {
    expect(verify({ signature: sign("x".repeat(64), ts, body) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("a signature does not transfer to another timestamp", () => {
    const t2 = String(NOW / 1000 + 10);
    expect(verify({ timestamp: t2 })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects wrong-length and prefix-less signatures without throwing", () => {
    expect(verify({ signature: "sha256=abc" }).ok).toBe(false);
    expect(verify({ signature: sign(secret, ts, body).slice("sha256=".length) }).ok).toBe(false);
    expect(verify({ signature: "" }).ok).toBe(false);
  });
});
