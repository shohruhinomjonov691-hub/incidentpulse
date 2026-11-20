import { randomUUID } from "node:crypto";
import type { Category, IncidentJob } from "@incidentpulse/schemas";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createInvestigationPolicy,
  DAILY_RECHECK_SCHEDULER_NAME,
  WEEKLY_SCHEDULER_NAME,
} from "../src/investigation-policy.ts";
import { createLogger } from "../src/log.ts";
import { createIncidentWorker } from "../src/worker.ts";
import { graphFor, job, makeMocks } from "./helpers.ts";

const redisUrl = process.env.IT_REDIS_URL;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(mode: "on_change" | "weekly", weeklySpentUsd = 0) {
  const prefix = `it:policy:${randomUUID()}`;
  const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
  cleanups.push(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  const mocks = makeMocks({ weeklySpentUsd });
  let now = new Date("2026-11-21T14:58:00Z");
  let hash = "old-evidence";
  const probe = vi.fn(async (incident: IncidentJob) => ({
    category: incident.category ?? ("tls" as const),
    hash,
    quickEvidence: [],
    unsafeAttempts: 0,
    injectionFlags: 0,
  }));
  const policy = createInvestigationPolicy({
    redis,
    prefix,
    mode,
    graph: graphFor(mocks),
    notifier: mocks.notifier,
    redact: mocks.deps.redact,
    now: () => now,
    probe,
  });
  const observations = (n: number, level = "down", category: Category = "tls") => {
    const at = new Date(Date.UTC(2026, 10, 21, 0, 0, n)).toISOString();
    return job({
      incidentId: `inc-${n}`,
      signal: { ...job().signal, level, at },
      category,
      receivedAt: at,
    });
  };
  return {
    policy,
    redis,
    prefix,
    mocks,
    probe,
    observations,
    advanceDay: () => {
      now = new Date(now.getTime() + 86_400_000);
    },
    changeEvidence: () => {
      hash = "new-evidence";
    },
  };
}

describe.skipIf(!redisUrl)("investigation policy (real Redis, mock agents and Telegram)", () => {
  test("repeat Down, once-per-Seoul-day reminder, changed evidence and category, and manual bypass", async () => {
    const f = fixture("on_change");
    const j = f.observations;
    expect(await f.policy.monitor(j(1))).toBe("investigated");
    expect(await f.policy.monitor(j(2))).toBe("cached");
    expect(await f.policy.monitor(j(3))).toBe("cached");
    expect(f.mocks.triage.calls).toBe(1);
    expect(f.mocks.notifier.sent[1]).toContain("davom etmoqda, xulosa:");
    expect(f.mocks.notifier.sent).toHaveLength(2);

    f.advanceDay();
    expect(await f.policy.monitor(j(4))).toBe("cached");
    expect(f.mocks.notifier.sent).toHaveLength(3);
    expect(f.mocks.triage.calls).toBe(1);
    const [cached] = await f.redis.keys(`${f.prefix}:conclusion:*`);
    expect(await f.redis.ttl(cached as string)).toBe(604_800);

    f.changeEvidence();
    expect(await f.policy.monitor(j(5))).toBe("investigated");
    expect(await f.policy.monitor(j(6, "down", "dns"))).toBe("investigated");
    expect(f.mocks.triage.calls).toBe(3);
    expect(await f.policy.manual("kervan", "manual-22")).toBe("investigated");
    expect(f.mocks.triage.calls).toBe(4);
  });

  test("a stale OK cannot reset Down; after cache expiration an actual OK→Down opens a new investigation", async () => {
    const f = fixture("on_change");
    const j = f.observations;
    await f.policy.monitor(j(2));
    expect(await f.policy.monitor(j(1, "ok"))).toBe("stale");
    const keys = await f.redis.keys(`${f.prefix}:conclusion:*`);
    await f.redis.del(...keys);
    expect(await f.policy.monitor(j(3))).toBe("unchanged");
    expect(await f.policy.monitor(j(4, "ok"))).toBe("recovered");
    expect(await f.policy.monitor(j(5))).toBe("investigated");
    expect(f.mocks.triage.calls).toBe(2);
  });

  test("a recovery and repeat fingerprint inside seven days reuses the conclusion", async () => {
    const f = fixture("on_change");
    const j = f.observations;
    await f.policy.monitor(j(1));
    await f.policy.monitor(j(2, "ok"));
    expect(await f.policy.monitor(j(3))).toBe("cached");
    expect(f.mocks.triage.calls).toBe(1);
  });

  test("manual requests bypass the cache, but the exhausted budget blocks their LLM calls", async () => {
    const f = fixture("on_change", 0.5);
    expect(await f.policy.manual("kervan", "manual-22")).toBe("weekly_budget");
    expect(f.mocks.triage.calls + f.mocks.specialists.infra.calls + f.mocks.synth.calls).toBe(0);
    expect(f.mocks.notifier.sent[0]).toContain("haftalik byudjet");
  });

  test("daily rechecks detect fresh evidence even without a repeated Down webhook", async () => {
    const f = fixture("on_change");
    const queueName = `it-daily-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: f.redis });
    cleanups.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const worker = await createIncidentWorker({
      redisUrl: redisUrl as string,
      investigations: f.policy,
      investigateMode: "on_change",
      notifier: f.mocks.notifier,
      redact: f.mocks.deps.redact,
      log: createLogger(
        (text) => text,
        () => {},
      ),
      queueName,
    });
    cleanups.push(() => worker.close());
    await f.policy.monitor(f.observations(1));
    f.advanceDay();
    await queue.add(DAILY_RECHECK_SCHEDULER_NAME, {});
    await vi.waitFor(() => expect(f.mocks.notifier.sent[1]).toContain("davom etmoqda"));
    expect(f.mocks.triage.calls).toBe(1);
    f.changeEvidence();
    await queue.add(DAILY_RECHECK_SCHEDULER_NAME, {});
    await vi.waitFor(() => expect(f.mocks.notifier.sent[2]).toContain("daily-recheck-"));
    expect(f.mocks.triage.calls).toBe(2);
  });

  test("weekly scheduler coalesces updates, removes recovered checks, and shares the queue with manual requests", async () => {
    const f = fixture("weekly");
    const j = f.observations;
    const queueName = `it-weekly-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: f.redis });
    cleanups.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const worker = await createIncidentWorker({
      redisUrl: redisUrl as string,
      investigations: f.policy,
      investigateMode: "weekly",
      notifier: f.mocks.notifier,
      redact: f.mocks.deps.redact,
      log: createLogger(
        (text) => text,
        () => {},
      ),
      queueName,
    });
    cleanups.push(() => worker.close());
    expect(await queue.getJobScheduler(WEEKLY_SCHEDULER_NAME)).toMatchObject({
      pattern: "0 0 9 * * 0",
      tz: "Asia/Seoul",
    });
    expect(await f.policy.monitor(j(1))).toBe("buffered");
    await f.policy.monitor(j(2, "ok"));
    expect(await f.policy.active()).toEqual([]);
    await f.policy.monitor(j(3));
    await f.policy.monitor(j(4));
    expect((await f.policy.active()).map((entry) => entry.incidentId)).toEqual(["inc-4"]);
    expect(f.probe).not.toHaveBeenCalled();

    await queue.add(WEEKLY_SCHEDULER_NAME, {});
    await vi.waitFor(() => expect(f.mocks.notifier.sent[0]).toContain("weekly-investigations-"));
    expect(f.mocks.triage.calls).toBe(1);

    await worker.enqueueManual("kervan", 456);
    await worker.enqueueManual("kervan", 456);
    await vi.waitFor(() => expect(f.mocks.notifier.sent[1]).toContain("manual-456"));
    expect(f.mocks.triage.calls).toBe(2);
  });
});
