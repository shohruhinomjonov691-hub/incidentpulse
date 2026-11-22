import { Redis } from "ioredis";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { POST } from "../src/app/api/session/route.ts";
import { clientIp, GLOBAL_FAILURE_LIMIT } from "../src/server/login-limit.ts";

const prefix = "it:web-login";
const proxySecret = "trusted-nginx-only".repeat(3);
const password = "admin-password-for-tests";
const origin = "https://incidentpulse.example";
let redis: Redis;
vi.mock("../src/server/store.ts", () => ({
  redis: () => redis,
  get loginPrefix() {
    return prefix;
  },
}));

test("forwarded addresses require the trusted nginx header and a single IP", () => {
  const headers = new Headers({ "x-forwarded-for": "192.0.2.10" });
  expect(clientIp(headers, proxySecret)).toBe("direct");
  headers.set("x-incidentpulse-proxy", "untrusted".repeat(6));
  expect(clientIp(headers, proxySecret)).toBe("direct");
  headers.set("x-incidentpulse-proxy", proxySecret);
  expect(clientIp(headers, proxySecret)).toBe("192.0.2.10");
  headers.set("x-forwarded-for", "192.0.2.11, 192.0.2.10");
  expect(clientIp(headers, proxySecret)).toBe("direct");
  headers.set("x-forwarded-for", "2001:db8::1");
  expect(clientIp(headers, proxySecret)).toBe("2001:db8::1");
});

describe.skipIf(!process.env.IT_REDIS_URL)("login route with real Redis", () => {
  async function clear() {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
  }
  beforeAll(async () => {
    redis = new Redis(process.env.IT_REDIS_URL as string);
    vi.stubEnv("WEB_ORIGIN", origin);
    vi.stubEnv("WEB_ADMIN_PASSWORD", password);
    vi.stubEnv("WEB_PROXY_SECRET", proxySecret);
    await clear();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await clear();
    await redis.quit();
  });
  const login = (ip: string, value = "wrong") =>
    POST(
      new NextRequest(`${origin}/api/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
          "x-incidentpulse-proxy": proxySecret,
        },
        body: JSON.stringify({ password: value }),
      }),
    );

  test("backs off progressively per client and lets other clients sign in", async () => {
    const ip = "192.0.2.10";
    expect((await login(ip)).status).toBe(401);
    expect((await login(ip)).status).toBe(401);
    const third = await login(ip);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    expect((await login(ip)).status).toBe(429);
    expect((await login("192.0.2.11", password)).status).toBe(200);

    await redis.del(`${prefix}:web:login:lock:${ip}`); // Advance past the first lock, retaining the count.
    const fourth = await login(ip);
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBe("10");
  });

  test("an exhausted global failure counter never blocks a correct password", async () => {
    await clear();
    for (let i = 0; i < GLOBAL_FAILURE_LIMIT; i++) {
      expect((await login(`198.51.100.${i + 1}`)).status).toBe(401);
    }
    expect((await login("192.0.2.20")).status).toBe(429);
    const success = await login("192.0.2.20", password);
    expect(success.status).toBe(200);
    expect(success.headers.get("set-cookie")).toContain("incidentpulse_session");
  });
});
