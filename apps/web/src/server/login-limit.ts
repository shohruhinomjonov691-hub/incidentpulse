import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Login throttling keyed by the client IP, with progressive backoff.
 *
 * nginx connects to the loopback publication, authenticates itself with a shared header, and replaces
 * X-Forwarded-For with the peer address it saw. The header verifies nginx even across Docker's address
 * translation. Requests without a verified proxy share one "direct" bucket.
 *
 * Order in the route: per-IP lock -> password check -> (success: reset) | (failure: count, back off). The
 * GLOBAL failure counter only changes how a WRONG password is answered; it is evaluated after the password, so
 * a flood from other addresses can never lock out the operator who knows the password.
 */

export interface LimiterStore {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<unknown>;
}

/** Failures that carry no delay at all (a typo is not an attack). */
const FREE_FAILURES = 2;
/** First lock after the free failures; doubles with each further failure. */
const BASE_LOCK_SECONDS = 5;
const MAX_LOCK_SECONDS = 900;
/** The failure counter forgets an address after this long without a failure. */
const FAILURE_WINDOW_SECONDS = 3600;
const GLOBAL_WINDOW_SECONDS = 900;
/** Wrong passwords per window across ALL addresses before wrong guesses are refused outright (429). */
export const GLOBAL_FAILURE_LIMIT = 60;

// Update both counters, expiries and backoff atomically across web requests.
const FAILURE = `
  local failures = redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], ${FAILURE_WINDOW_SECONDS})
  local seconds = 0
  if failures > ${FREE_FAILURES} then
    seconds = math.min(${MAX_LOCK_SECONDS}, ${BASE_LOCK_SECONDS} * 2 ^ (failures - ${FREE_FAILURES + 1}))
    redis.call('SET', KEYS[2], '1', 'EX', seconds)
  end
  local total = redis.call('INCR', KEYS[3])
  if total == 1 then redis.call('EXPIRE', KEYS[3], ${GLOBAL_WINDOW_SECONDS}) end
  return {seconds, total}
`;

export function clientIp(headers: Pick<Headers, "get">, proxySecret?: string): string {
  if (!proxySecret || proxySecret.length < 32) return "direct";
  const expected = Buffer.from(proxySecret);
  const supplied = Buffer.from(headers.get("x-incidentpulse-proxy") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return "direct";
  const forwarded = headers.get("x-forwarded-for")?.trim().toLowerCase();
  return forwarded && isIP(forwarded) ? forwarded : "direct";
}

export function createLoginLimiter(store: LimiterStore, prefix: string) {
  const fail = (ip: string) => `${prefix}:web:login:fail:${ip}`;
  const lock = (ip: string) => `${prefix}:web:login:lock:${ip}`;
  const global = `${prefix}:web:login:global`;
  return {
    /** Seconds this address must still wait; 0 = may try. */
    async retryAfter(ip: string): Promise<number> {
      const ms = await store.pttl(lock(ip));
      return ms > 0 ? Math.ceil(ms / 1000) : 0;
    },

    /** Record a wrong password. `refuse` = answer 429 instead of 401 (this address is locked, or global flood). */
    async failure(ip: string): Promise<{ retryAfter: number; refuse: boolean }> {
      const [seconds, total] = (await store.eval(FAILURE, 3, fail(ip), lock(ip), global)) as [
        number,
        number,
      ];
      return { retryAfter: seconds, refuse: seconds > 0 || total > GLOBAL_FAILURE_LIMIT };
    },

    /** A correct password clears this address (and only this address). */
    async success(ip: string): Promise<void> {
      await store.del(fail(ip), lock(ip));
    },
  };
}
