import type { IncidentJob } from "@incidentpulse/schemas";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildServer, type IncidentQueue } from "../src/server.ts";
import { SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from "../src/signature.ts";

const secret = "k".repeat(64);
const NOW = Date.UTC(2026, 10, 21, 4, 0, 0);

const validBody = {
  project: "kervan",
  check: "https",
  level: "down",
  summary: "HTTPS check failed",
  at: "2026-11-21T03:59:50.000Z",
};

function signedHeaders(raw: string, timestamp = String(Math.floor(NOW / 1000))) {
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sign(secret, timestamp, raw),
  };
}

let jobs: IncidentJob[];
let seenKeys: Map<string, string>;
let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  jobs = [];
  seenKeys = new Map();
  // Fake queue with the same dedup semantics as the BullMQ adapter.
  const queue: IncidentQueue = {
    async enqueue(job) {
      const existing = seenKeys.get(job.dedupKey);
      if (existing) return { incidentId: existing, deduplicated: true };
      seenKeys.set(job.dedupKey, job.incidentId);
      jobs.push(job);
      return { incidentId: job.incidentId, deduplicated: false };
    },
  };
  let n = 0;
  app = buildServer({ secret, queue, now: () => NOW, newIncidentId: () => `inc-test-${++n}` });
});
afterEach(() => app.close());

const post = (raw: string, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/webhook/monitor", headers, payload: raw });

describe("POST /webhook/monitor", () => {
  test("a valid signed Down signal is queued (202)", async () => {
    const raw = JSON.stringify(validBody);
    const res = await post(raw, signedHeaders(raw));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "queued", incidentId: "inc-test-1" });
    expect(jobs).toEqual([
      {
        incidentId: "inc-test-1",
        project: "kervan",
        signal: { check: "https", level: "down", summary: "HTTPS check failed", at: validBody.at },
        dedupKey: "kervan:https:unknown",
        receivedAt: new Date(NOW).toISOString(),
      },
    ]);
  });

  test("level is matched case-insensitively and normalized", async () => {
    const raw = JSON.stringify({ ...validBody, level: "Down" });
    expect((await post(raw, signedHeaders(raw))).statusCode).toBe(202);
    expect(jobs[0]?.signal.level).toBe("down");
  });

  test("the same project+check twice is deduplicated and returns the first incident id", async () => {
    const raw = JSON.stringify(validBody);
    await post(raw, signedHeaders(raw));
    const second = await post(raw, signedHeaders(raw));
    expect(second.json()).toEqual({ status: "duplicate", incidentId: "inc-test-1" });
    expect(jobs).toHaveLength(1);
  });

  test("a different check or project is a separate incident", async () => {
    for (const body of [
      validBody,
      { ...validBody, check: "api" },
      { ...validBody, project: "gotrip" },
    ]) {
      const raw = JSON.stringify(body);
      await post(raw, signedHeaders(raw));
    }
    expect(jobs).toHaveLength(3);
  });

  test("OK (recovery) signals are acknowledged but not queued", async () => {
    const raw = JSON.stringify({ ...validBody, level: "ok" });
    const res = await post(raw, signedHeaders(raw));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "ignored" });
    expect(jobs).toHaveLength(0);
  });

  test.each([
    ["no signature headers", () => ({ "content-type": "application/json" })],
    ["wrong signature", () => ({ ...signedHeaders("{}"), "content-type": "application/json" })],
    [
      "timestamp 6 minutes old",
      (raw: string) => signedHeaders(raw, String(Math.floor(NOW / 1000) - 360)),
    ],
    [
      "timestamp 6 minutes in the future",
      (raw: string) => signedHeaders(raw, String(Math.floor(NOW / 1000) + 360)),
    ],
  ])("401 and nothing queued: %s", async (_name, headers) => {
    const raw = JSON.stringify(validBody);
    const res = await post(raw, headers(raw));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(jobs).toHaveLength(0);
  });

  test("a body altered after signing is rejected", async () => {
    const raw = JSON.stringify(validBody);
    const res = await post(raw.replace("kervan", "gotrip"), signedHeaders(raw));
    expect(res.statusCode).toBe(401);
  });

  test("400 for signed-but-invalid JSON", async () => {
    const raw = "{not json";
    const res = await post(raw, signedHeaders(raw));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_json" });
  });

  test.each([
    ["unknown project", { ...validBody, project: "nope" }, "project"],
    ["missing check", { ...validBody, check: undefined }, "check"],
    ["extra field", { ...validBody, extra: 1 }, "(root)"],
    ["oversized summary", { ...validBody, summary: "x".repeat(1001) }, "summary"],
    ["bad timestamp", { ...validBody, at: "yesterday" }, "at"],
  ])("400 for %s", async (_name, body, field) => {
    const raw = JSON.stringify(body);
    const res = await post(raw, signedHeaders(raw));
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain(field);
    expect(jobs).toHaveLength(0);
  });

  test("bodies over 16 KiB are refused", async () => {
    const raw = JSON.stringify({ ...validBody, summary: "x".repeat(20_000) });
    const res = await post(raw, signedHeaders(raw));
    expect(res.statusCode).toBe(413);
  });

  test("never echoes the secret or signature in any response", async () => {
    const raw = JSON.stringify(validBody);
    const headers = signedHeaders(raw);
    const res = await post(raw, { ...headers, [SIGNATURE_HEADER]: "sha256=00" });
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain(headers[SIGNATURE_HEADER]);
  });
});
