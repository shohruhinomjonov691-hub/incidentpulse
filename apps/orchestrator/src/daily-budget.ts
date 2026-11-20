/**
 * Daily spend counter (SPEC §8: $3 per day). One integer counter per calendar day in a fixed
 * IANA time zone (default Asia/Seoul), in micro-USD, incremented atomically with INCRBY so
 * concurrent workers cannot lose updates.
 * Check-then-spend is not atomic: with N concurrent incidents the day can overshoot by at most
 * N LLM calls (one worker today, so effectively one call).
 */

export interface DailyBudget {
  spentUsd(now: Date): Promise<number>;
  /** Adds spend and returns the new total for that day. */
  addUsd(usd: number, now: Date): Promise<number>;
}

/** The slice of ioredis we use; lets tests pass a fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const MICRO = 1_000_000;
const KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

export const DEFAULT_BUDGET_TIMEZONE = "Asia/Seoul";
export const DEFAULT_KEY_PREFIX = "incidentpulse:budget:daily";

/** Calendar day (YYYY-MM-DD) in `timeZone`, e.g. 2026-11-22 for 2026-11-21T15:00Z in Asia/Seoul. */
export function dayKey(now: Date, timeZone: string = DEFAULT_BUDGET_TIMEZONE): string {
  // The en-CA locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("spend must be a non-negative number");
  return Math.round(usd * MICRO);
}

export function createRedisDailyBudget(
  redis: RedisLike,
  options: { keyPrefix?: string; timeZone?: string } = {},
): DailyBudget {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const key = (now: Date) => `${prefix}:${dayKey(now, options.timeZone)}`;
  return {
    async spentUsd(now) {
      return Number((await redis.get(key(now))) ?? 0) / MICRO;
    },
    async addUsd(usd, now) {
      const k = key(now);
      const total = await redis.incrby(k, toMicro(usd));
      await redis.expire(k, KEY_TTL_SECONDS);
      return total / MICRO;
    },
  };
}

/** In-memory implementation with the same semantics (tests, local runs without Redis). */
export function createMemoryDailyBudget(
  initialUsd = 0,
  initialNow = new Date(),
  timeZone: string = DEFAULT_BUDGET_TIMEZONE,
): DailyBudget {
  const totals = new Map<string, number>([[dayKey(initialNow, timeZone), toMicro(initialUsd)]]);
  return {
    async spentUsd(now) {
      return (totals.get(dayKey(now, timeZone)) ?? 0) / MICRO;
    },
    async addUsd(usd, now) {
      const k = dayKey(now, timeZone);
      const total = (totals.get(k) ?? 0) + toMicro(usd);
      totals.set(k, total);
      return total / MICRO;
    },
  };
}
