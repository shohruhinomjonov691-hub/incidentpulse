import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const COOKIE = "incidentpulse_session";
const MAX_AGE = 8 * 60 * 60;
const secret = () => process.env.WEB_ADMIN_PASSWORD;
const digest = (value: string) => createHash("sha256").update(value).digest();

export function validPassword(password: string) {
  const expected = secret();
  return !!expected && expected.length >= 16 && timingSafeEqual(digest(password), digest(expected));
}

function sign(value: string, password: string) {
  return createHmac("sha256", password)
    .update(`incidentpulse:web:session:${value}`)
    .digest("base64url");
}

export function newSession(now = Date.now()) {
  const password = secret();
  if (!password || password.length < 16) throw new Error("Web admin is not configured");
  const value = `${Math.floor(now / 1000) + MAX_AGE}.${randomBytes(24).toString("base64url")}`;
  return `${value}.${sign(value, password)}`;
}

export function validSession(token: string | undefined, now = Date.now()) {
  const password = secret();
  const match = /^(\d{1,12})\.([\w-]{32})\.([\w-]{43})$/.exec(token ?? "");
  if (!password || password.length < 16 || !match || Number(match[1]) <= now / 1000) return false;
  return timingSafeEqual(
    Buffer.from(match[3] ?? ""),
    Buffer.from(sign(`${match[1]}.${match[2]}`, password)),
  );
}

export async function isAdmin() {
  return validSession((await cookies()).get(COOKIE)?.value);
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/login");
}

export function originMatches(request: Request) {
  return request.headers.get("origin") === (process.env.WEB_ORIGIN ?? new URL(request.url).origin);
}

export function sessionOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    maxAge: MAX_AGE,
    secure: !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(process.env.WEB_ORIGIN ?? ""),
  };
}

export async function readJson(request: Request, cap: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      size += value.length;
      if (size > cap) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
