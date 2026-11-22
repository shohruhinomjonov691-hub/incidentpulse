import { Redis } from "ioredis";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GET } from "../src/app/api/incidents/[id]/events/route.ts";
import { DELETE, POST } from "../src/app/api/session/route.ts";
import { clientIp, GLOBAL_FAILURE_LIMIT } from "../src/server/login-limit.ts";
import { COOKIE, newSession, validSession } from "../src/server/session.ts";

const prefix = "it:web-login";
const proxySecret = "trusted-nginx-only".repeat(3);
const password = "admin-password-for-tests";
const origin = "https://incidentpulse.example";
let redis: Redis;
const journal = { get: vi.fn(async () => ({})), events: vi.fn() };
vi.mock("../src/server/store.ts", () => ({
  redis: () => redis,
  journal: () => journal,
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

describe.skipIf(!process.env.IT_REDIS_URL)("session routes with real Redis", () => {
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

  async function loginToken(ip: string, value = password) {
    const response = await login(ip, value);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toMatch(/^incidentpulse_session=v2\./);
    return cookie.slice(COOKIE.length + 1);
  }

  function logout(token: string, requestOrigin = origin) {
    return DELETE(
      new NextRequest(`${origin}/api/session`, {
        method: "DELETE",
        headers: { origin: requestOrigin, cookie: `${COOKIE}=${token}` },
      }),
    );
  }

  function events(token: string) {
    return GET(
      new NextRequest(`${origin}/api/incidents/test-incident/events`, {
        headers: { cookie: `${COOKIE}=${token}` },
      }),
      { params: Promise.resolve({ id: "test-incident" }) },
    );
  }

  test("logout rejects the copied cookie and stops an open stream with a pending event", async () => {
    const token = await loginToken("192.0.2.31");
    const other = await loginToken("192.0.2.32");
    let finishEvents!: (events: { id: string }[]) => void;
    const reading = new Promise<void>((started) => {
      journal.events.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          finishEvents = resolve;
        });
      });
    });
    const response = await events(token);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(": connected");
    await reading;

    expect((await logout(token, "https://other.example")).status).toBe(403);
    expect(await validSession(token)).toBe(true);
    const deleted = await logout(token);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await events(token)).status).toBe(401);
    expect(await validSession(other)).toBe(true);

    finishEvents([{ id: "1" }]);
    expect(await reader?.read()).toMatchObject({ done: true });
  });

  test("password rotation invalidates all issued sessions, including after restoring the password", async () => {
    const first = await loginToken("192.0.2.41");
    const second = await loginToken("192.0.2.42");
    vi.stubEnv("WEB_ADMIN_PASSWORD", `${password}-rotated`);
    try {
      expect(await validSession(undefined)).toBe(false); // Unauthenticated login healthcheck.
      expect((await events(first)).status).toBe(401);
      expect((await events(second)).status).toBe(401);
      const fresh = await loginToken("192.0.2.43", `${password}-rotated`);
      expect(await validSession(fresh)).toBe(true);
    } finally {
      vi.stubEnv("WEB_ADMIN_PASSWORD", password);
    }
    expect(await validSession(first)).toBe(false);
    expect(await validSession(second)).toBe(false);
    expect(await validSession(await loginToken("192.0.2.44"))).toBe(true);
  });

  test("sessions expire and Redis failures cannot authenticate or report successful logout", async () => {
    expect(await validSession(await newSession(Date.now() - 8 * 60 * 60 * 1000))).toBe(false);
    const token = await loginToken("192.0.2.51");
    const evalSpy = vi.spyOn(redis, "eval").mockRejectedValueOnce(new Error("Redis unavailable"));
    try {
      expect((await events(token)).status).toBe(401);
    } finally {
      evalSpy.mockRestore();
    }
    const delSpy = vi.spyOn(redis, "del").mockRejectedValueOnce(new Error("Redis unavailable"));
    try {
      const response = await logout(token);
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      delSpy.mockRestore();
    }
    expect(await validSession(token)).toBe(true);
  });
});
