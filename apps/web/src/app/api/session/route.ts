import { type NextRequest, NextResponse } from "next/server";
import { clientIp, createLoginLimiter } from "../../../server/login-limit.ts";
import {
  COOKIE,
  newSession,
  originMatches,
  readJson,
  sessionOptions,
  validPassword,
} from "../../../server/session.ts";
import { loginPrefix, redis } from "../../../server/store.ts";

export async function POST(request: NextRequest) {
  if (!originMatches(request)) return new Response(null, { status: 403 });
  const body = (await readJson(request, 2048)) as { password?: unknown } | null;
  if (typeof body?.password !== "string") return new Response(null, { status: 400 });
  const ip = clientIp(request.headers, process.env.WEB_PROXY_SECRET);
  try {
    const limiter = createLoginLimiter(redis(), loginPrefix);
    // 1. This address is locked out (progressive backoff): refused before the password is even looked at.
    const wait = await limiter.retryAfter(ip);
    if (wait > 0) return tooMany(wait);
    // 2. The password decides. A correct one is never blocked by the GLOBAL failure counter.
    if (validPassword(body.password)) {
      await limiter.success(ip);
      const response = NextResponse.json({ ok: true });
      response.cookies.set(COOKIE, newSession(), sessionOptions());
      return response;
    }
    const failed = await limiter.failure(ip);
    return failed.refuse ? tooMany(failed.retryAfter || 60) : new Response(null, { status: 401 });
  } catch {
    return new Response(null, { status: 503 });
  }
}

const tooMany = (seconds: number) =>
  new Response(null, { status: 429, headers: { "Retry-After": String(seconds) } });

export async function DELETE(request: NextRequest) {
  if (!originMatches(request)) return new Response(null, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, "", { ...sessionOptions(), maxAge: 0 });
  return response;
}
