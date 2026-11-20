import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, test } from "vitest";
import {
  createMemoryDailyBudget,
  createRedisDailyBudget,
  dayKey,
  type RedisLike,
} from "../src/daily-budget.ts";

// Seoul is UTC+9 (no DST): 14:59:59Z is the last second of Nov 21 there, 15:00:00Z is Nov 22 00:00.
const DAY1 = new Date("2026-11-21T14:59:59.000Z");
const DAY2 = new Date("2026-11-21T15:00:00.000Z");

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

describe("dayKey", () => {
  test("defaults to the Asia/Seoul calendar day (not UTC)", () => {
    expect(dayKey(new Date("2026-11-21T14:59:59.999Z"))).toBe("2026-11-21");
    expect(dayKey(new Date("2026-11-21T15:00:00.000Z"))).toBe("2026-11-22");
    // In UTC this instant is still Nov 21; in Seoul it is already Nov 22.
    expect(dayKey(new Date("2026-11-21T20:00:00.000Z"), "UTC")).toBe("2026-11-21");
    expect(dayKey(new Date("2026-11-21T20:00:00.000Z"))).toBe("2026-11-22");
  });

  test("honours another IANA zone", () => {
    expect(dayKey(new Date("2026-11-21T04:00:00.000Z"), "America/Los_Angeles")).toBe("2026-11-20");
  });

  test("the boundary is the same all year (Seoul has no DST)", () => {
    expect(dayKey(new Date("2026-07-01T14:59:59.000Z"))).toBe("2026-07-01");
    expect(dayKey(new Date("2026-07-01T15:00:00.000Z"))).toBe("2026-07-02");
  });
});

describe("createRedisDailyBudget (fake Redis)", () => {
  test("stores integer micro-USD under a per-Seoul-day key and sets a TTL", async () => {
    const { redis, data, ttl } = fakeRedis();
    const budget = createRedisDailyBudget(redis, { keyPrefix: "t" });
    expect(await budget.spentUsd(DAY1)).toBe(0);
    expect(await budget.addUsd(0.003739, DAY1)).toBeCloseTo(0.003739, 9);
    expect(await budget.addUsd(0.002, DAY1)).toBeCloseTo(0.005739, 9);
    expect(data.get("t:2026-11-21")).toBe(5739);
    expect(ttl.get("t:2026-11-21")).toBe(172_800);
  });

  test("float accumulation does not drift (0.1 × 30 = 3.0)", async () => {
    const budget = createRedisDailyBudget(fakeRedis().redis);
    let total = 0;
    for (let i = 0; i < 30; i++) total = await budget.addUsd(0.1, DAY1);
    expect(total).toBe(3);
  });

  test("a new Seoul day starts at zero and does not touch yesterday's counter", async () => {
    const budget = createRedisDailyBudget(fakeRedis().redis);
    await budget.addUsd(2.5, DAY1);
    expect(await budget.spentUsd(DAY2)).toBe(0);
    expect(await budget.spentUsd(DAY1)).toBe(2.5);
  });

  test("the time zone is configurable", async () => {
    const { redis, data } = fakeRedis();
    const utc = createRedisDailyBudget(redis, { keyPrefix: "u", timeZone: "UTC" });
    await utc.addUsd(1, DAY2); // 15:00Z Nov 21 is still Nov 21 in UTC
    expect([...data.keys()]).toEqual(["u:2026-11-21"]);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects spend %s", async (bad) => {
    await expect(createRedisDailyBudget(fakeRedis().redis).addUsd(bad, DAY1)).rejects.toThrow();
  });
});

describe("createMemoryDailyBudget", () => {
  test("same semantics: initial value, accumulation, day rollover", async () => {
    const budget = createMemoryDailyBudget(1, DAY1);
    expect(await budget.spentUsd(DAY1)).toBe(1);
    expect(await budget.addUsd(0.5, DAY1)).toBe(1.5);
    expect(await budget.spentUsd(DAY2)).toBe(0);
  });
});

// Real Redis: IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379
const url = process.env.IT_REDIS_URL;
describe.skipIf(!url)("createRedisDailyBudget (real Redis)", () => {
  const redis = new Redis(url as string);
  // Unique prefix: never touches the real daily counter.
  const prefix = `it:budget:${randomUUID()}`;
  const budget = createRedisDailyBudget(redis, { keyPrefix: prefix });

  afterAll(async () => {
    await redis.del(`${prefix}:${dayKey(DAY1)}`, `${prefix}:${dayKey(DAY2)}`);
    redis.disconnect();
  });

  test("INCRBY is atomic: 50 concurrent increments sum exactly", async () => {
    await Promise.all(Array.from({ length: 50 }, () => budget.addUsd(0.01, DAY1)));
    expect(await budget.spentUsd(DAY1)).toBeCloseTo(0.5, 9);
  });

  test("the key expires on its own (TTL set) and days are independent", async () => {
    const ttl = await redis.ttl(`${prefix}:${dayKey(DAY1)}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(172_800);
    expect(await budget.spentUsd(DAY2)).toBe(0);
  });
});
