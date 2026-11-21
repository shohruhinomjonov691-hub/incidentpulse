/** Redis keeps spend as integer micro-USD, by Monday-start calendar week in Seoul. */
export interface WeeklyBudget {
  spentUsd(now: Date): Promise<number>;
  addUsd(usd: number, now: Date): Promise<number>;
  releaseUsd(usd: number, now: Date): Promise<number>;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export async function reserveWeekly(
  redis: { eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown> },
  at: Date,
  usd: number,
  limit: number,
  prefix = "incidentpulse:budget:weekly",
) {
  const accepted = await redis.eval(
    `local used = tonumber(redis.call('GET', KEYS[1]) or '0')
     if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return 0 end
     redis.call('INCRBY', KEYS[1], ARGV[1])
     redis.call('EXPIRE', KEYS[1], ARGV[3])
     return 1`,
    1,
    `${prefix}:${weekKey(at)}`,
    toMicro(usd),
    toMicro(limit),
    KEY_TTL_SECONDS,
  );
  return accepted === 1;
}

const MICRO = 1_000_000;
const KEY_TTL_SECONDS = 14 * 24 * 60 * 60;

export const SEOUL_TIMEZONE = "Asia/Seoul";
const seoulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: SEOUL_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dayKey(now: Date): string {
  return seoulDate.format(now);
}

export function weekKey(now: Date): string {
  const date = new Date(dayKey(now));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function toMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("spend must be a non-negative number");
  return Math.round(usd * MICRO);
}

export function createRedisWeeklyBudget(
  redis: RedisLike,
  options: { keyPrefix?: string } = {},
): WeeklyBudget {
  const prefix = options.keyPrefix ?? "incidentpulse:budget:weekly";
  const key = (now: Date) => `${prefix}:${weekKey(now)}`;
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
    async releaseUsd(usd, now) {
      return (await redis.incrby(key(now), -toMicro(usd))) / MICRO;
    },
  };
}

export function createMemoryWeeklyBudget(initialUsd = 0, initialNow = new Date()): WeeklyBudget {
  const totals = new Map([[weekKey(initialNow), toMicro(initialUsd)]]);
  return {
    async spentUsd(now) {
      return (totals.get(weekKey(now)) ?? 0) / MICRO;
    },
    async addUsd(usd, now) {
      const k = weekKey(now);
      const total = (totals.get(k) ?? 0) + toMicro(usd);
      totals.set(k, total);
      return total / MICRO;
    },
    async releaseUsd(usd, now) {
      const k = weekKey(now);
      const total = (totals.get(k) ?? 0) - toMicro(usd);
      totals.set(k, total);
      return total / MICRO;
    },
  };
}
