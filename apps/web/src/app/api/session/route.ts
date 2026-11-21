import { type NextRequest, NextResponse } from "next/server";
import {
  COOKIE,
  newSession,
  originMatches,
  readJson,
  sessionOptions,
  validPassword,
} from "../../../server/session.ts";
import { loginKey, redis } from "../../../server/store.ts";

export async function POST(request: NextRequest) {
  if (!originMatches(request)) return new Response(null, { status: 403 });
  const body = (await readJson(request, 2048)) as { password?: unknown } | null;
  if (typeof body?.password !== "string") return new Response(null, { status: 400 });
  let count: unknown;
  try {
    count = await redis().eval(
      `local hits=redis.call('INCR', KEYS[1])
      if hits==1 then redis.call('EXPIRE',KEYS[1],900) end return hits`,
      1,
      loginKey,
    );
  } catch {
    return new Response(null, { status: 503 });
  }
  if (typeof count !== "number" || count > 8) return new Response(null, { status: 429 });
  if (!validPassword(body.password)) return new Response(null, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, newSession(), sessionOptions());
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!originMatches(request)) return new Response(null, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, "", { ...sessionOptions(), maxAge: 0 });
  return response;
}
