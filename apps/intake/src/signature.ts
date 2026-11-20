import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing contract (SPEC §12, §10). CodeTrail must send:
 *   X-IncidentPulse-Timestamp: <unix seconds>
 *   X-IncidentPulse-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 * Binding the timestamp into the MAC makes a captured request useless after the 5-minute window.
 */
export const TIMESTAMP_HEADER = "x-incidentpulse-timestamp";
export const SIGNATURE_HEADER = "x-incidentpulse-signature";
export const TOLERANCE_SECONDS = 300;

export function sign(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `sha256=${mac}`;
}

export type Verification =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature";
    };

export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  nowMs: number;
  toleranceSeconds?: number;
}): Verification {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const skew = Math.abs(input.nowMs / 1000 - Number(timestamp));
  if (skew > (input.toleranceSeconds ?? TOLERANCE_SECONDS)) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = Buffer.from(sign(input.secret, timestamp, input.rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
