import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, test } from "vitest";
import { limitModelSpend, WeeklyBudgetExhausted } from "../src/agents/sdk.ts";
import {
  createMemoryWeeklyBudget,
  createRedisWeeklyBudget,
  dayKey,
  type RedisLike,
  weekKey,
} from "../src/weekly-budget.ts";
import { finalText, ScriptedModel } from "./scripted-model.ts";

// Sunday 23:59:59 and Monday 00:00:00 in Seoul.
const DAY1 = new Date("2026-11-22T14:59:59.000Z");
const DAY2 = new Date("2026-11-22T15:00:00.000Z");

/** A minimal fake of the Redis commands we use, to verify keys / TTLs / integer maths. */
function fakeRedis() {
  const data = new Map<string, number>();
  const ttl = new Map<string, number>();
  const redis: RedisLike = {
    async get(key) {
      return data.has(key) ? String(data.get(key)) : null;
    },
    async incrby(key, inc) {
      const next = (data.get(key) ?? 0) + inc;
      data.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      ttl.set(key, seconds);
      return 1;
    },
  };
  return { redis, data, ttl };
}

test("reminders use Seoul days; the budget rolls over only at Seoul Monday midnight", () => {
  expect(dayKey(new Date("2026-11-21T15:00:00.000Z"))).toBe("2026-11-22");
  expect(weekKey(new Date("2026-11-21T15:00:00.000Z"))).toBe("2026-11-16");
  expect(weekKey(DAY1)).toBe("2026-11-16");
  expect(weekKey(DAY2)).toBe("2026-11-23");
  expect(weekKey(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-12-28");
});

describe("createRedisWeeklyBudget (fake Redis)", () => {
  test("stores integer micro-USD under a per-Seoul-week key and sets a TTL", async () => {
    const { redis, data, ttl } = fakeRedis();
    const budget = createRedisWeeklyBudget(redis, { keyPrefix: "t" });
    expect(await budget.spentUsd(DAY1)).toBe(0);
    expect(await budget.addUsd(0.003739, DAY1)).toBeCloseTo(0.003739, 9);
    expect(await budget.addUsd(0.002, DAY1)).toBeCloseTo(0.005739, 9);
    expect(data.get("t:2026-11-16")).toBe(5739);
    expect(ttl.get("t:2026-11-16")).toBe(1_209_600);
  });

  test("float accumulation does not drift (0.1 × 30 = 3.0)", async () => {
    const budget = createRedisWeeklyBudget(fakeRedis().redis);
    let total = 0;
    for (let i = 0; i < 30; i++) total = await budget.addUsd(0.1, DAY1);
    expect(total).toBe(3);
  });

  test("a new Seoul week starts at zero and preserves prior spend", async () => {
    const budget = createRedisWeeklyBudget(fakeRedis().redis);
    await budget.addUsd(2.5, DAY1);
    expect(await budget.spentUsd(DAY2)).toBe(0);
    expect(await budget.spentUsd(DAY1)).toBe(2.5);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects spend %s", async (bad) => {
    await expect(createRedisWeeklyBudget(fakeRedis().redis).addUsd(bad, DAY1)).rejects.toThrow();
  });
});

describe("createMemoryWeeklyBudget", () => {
  test("same semantics: initial value, accumulation, week rollover", async () => {
    const budget = createMemoryWeeklyBudget(1, DAY1);
    expect(await budget.spentUsd(DAY1)).toBe(1);
    expect(await budget.addUsd(0.5, DAY1)).toBe(1.5);
    expect(await budget.spentUsd(DAY2)).toBe(0);
  });
});

// Real Redis: IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379
const url = process.env.IT_REDIS_URL;
describe.skipIf(!url)("createRedisWeeklyBudget (real Redis)", () => {
  const redis = new Redis(url as string);
  // Unique prefix: never touches the real weekly counter.
  const prefix = `it:budget:${randomUUID()}`;
  const budget = createRedisWeeklyBudget(redis, { keyPrefix: prefix });

  afterAll(async () => {
    await redis.del(`${prefix}:${weekKey(DAY1)}`, `${prefix}:${weekKey(DAY2)}`);
    redis.disconnect();
  });

  test("INCRBY is atomic: 50 concurrent increments sum exactly", async () => {
    await Promise.all(Array.from({ length: 50 }, () => budget.addUsd(0.01, DAY1)));
    expect(await budget.spentUsd(DAY1)).toBeCloseTo(0.5, 9);
  });

  test("the key expires on its own (TTL set) and weeks are independent", async () => {
    const ttl = await redis.ttl(`${prefix}:${weekKey(DAY1)}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_209_600);
    expect(await budget.spentUsd(DAY2)).toBe(0);
  });
});

test("provider usage is booked before a parallel request would cross the exhausted weekly limit", async () => {
  const budget = createMemoryWeeklyBudget(0.499, DAY1);
  const model = new ScriptedModel([finalText("finished", [1000, 100])]);
  const guarded = limitModelSpend(model, {
    budget,
    limitUsd: 0.5,
    pricing: { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
    now: () => DAY1,
  });
  const request = {} as Parameters<typeof model.getResponse>[0];
  const results = await Promise.allSettled([
    guarded.getResponse(request),
    guarded.getResponse(request),
    guarded.getResponse(request),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  for (const result of results.slice(1)) {
    expect(result).toMatchObject({ status: "rejected", reason: expect.any(WeeklyBudgetExhausted) });
  }
  expect(model.requests).toHaveLength(1);
  expect(await budget.spentUsd(DAY1)).toBeCloseTo(0.5002, 7);
});
