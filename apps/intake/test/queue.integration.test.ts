import { randomUUID } from "node:crypto";
import type { IncidentJob } from "@incidentpulse/schemas";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, test } from "vitest";
import { createBullQueue } from "../src/queue.ts";

// Needs a real Redis: IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 (docker compose up -d)
const url = process.env.IT_REDIS_URL;
const queueName = `it-intake-${randomUUID()}`;

const job = (id: string): IncidentJob => ({
  incidentId: id,
  project: "kervan",
  signal: { check: "https", level: "down", summary: "x", at: "2026-11-21T04:00:00.000Z" },
  dedupKey: "kervan:https:unknown",
  receivedAt: "2026-11-21T04:00:01.000Z",
});

describe.skipIf(!url)("BullMQ producer (real Redis)", () => {
  const queue = createBullQueue({ redisUrl: url as string, dedupTtlMs: 5000, queueName });

  afterAll(async () => {
    await queue.close();
    const conn = new Redis(url as string, { maxRetriesPerRequest: null });
    const q = new Queue(queueName, { connection: conn });
    await q.obliterate({ force: true });
    await q.close();
    conn.disconnect();
  });

  test("dedups the same project+check and returns the original incident id", async () => {
    const first = await queue.enqueue(job("inc-a"));
    const second = await queue.enqueue(job("inc-b"));
    expect(first).toEqual({ incidentId: "inc-a", deduplicated: false });
    expect(second).toEqual({ incidentId: "inc-a", deduplicated: true });
  });
});
