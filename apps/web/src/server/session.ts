import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loginPrefix, redis } from "./store.ts";

export const COOKIE = "incidentpulse_session";
const MAX_AGE = 8 * 60 * 60;
const TOKEN = /^v2\.(\d{1,12})\.([\w-]{32})\.([\w-]{43})$(?!.)/s;
const secret = () => process.env.WEB_ADMIN_PASSWORD;
const digest = (value: string) => createHash("sha256").update(value).digest();
const sessionKey = (token: string) => `${loginPrefix}:web:session:${digest(token).toString("hex")}`;

export function validPassword(password: string) {
  const expected = secret();
  return !!expected && expected.length >= 16 && timingSafeEqual(digest(password), digest(expected));
}

function sign(value: string, password: string) {
  return createHmac("sha256", password)
    .update(`incidentpulse:web:session:${value}`)
    .digest("base64url");
}

// Rotate the generation atomically on a password change, including a return to a previous password.
// A lookup with a session key also checks that this individual session is still active.
const SESSION_VERSION = `
local current = redis.call('GET', KEYS[1])
if not current or string.sub(current, 1, #ARGV[1]) ~= ARGV[1] then
  current = ARGV[1] .. ARGV[2]
  redis.call('SET', KEYS[1], current)
end
if KEYS[2] and redis.call('EXISTS', KEYS[2]) == 0 then return false end
return string.sub(current, #ARGV[1] + 1)
`;

async function sessionVersion(password: string, token?: string) {
  const keys = [`${loginPrefix}:web:session-version`];
  if (token) keys.push(sessionKey(token));
  return (await redis().eval(
    SESSION_VERSION,
    keys.length,
    ...keys,
    `${sign("password-version", password)}:`,
    randomBytes(24).toString("base64url"),
  )) as string | null;
}

export async function newSession(now = Date.now()) {
  const password = secret();
  if (!password || password.length < 16) throw new Error("Web admin is not configured");
  const version = await sessionVersion(password);
  const value = `v2.${Math.floor(now / 1000) + MAX_AGE}.${randomBytes(24).toString("base64url")}`;
  const token = `${value}.${sign(`${version}:${value}`, password)}`;
  await redis().set(sessionKey(token), "1", "EX", MAX_AGE);
  return token;
}

export async function validSession(token: string | undefined, now = Date.now()) {
  const password = secret();
  if (!password || password.length < 16) return false;
  const match = TOKEN.exec(token ?? "");
  try {
    // The login page and its healthcheck observe password rotations even without a cookie.
    const version = await sessionVersion(password, match?.[0]);
    if (!version || !match || Number(match[1]) <= now / 1000) return false;
    return timingSafeEqual(
      Buffer.from(match[3] ?? ""),
      Buffer.from(sign(`${version}:v2.${match[1]}.${match[2]}`, password)),
    );
  } catch {
    return false;
  }
}

export async function revokeSession(token: string | undefined) {
  if (token && TOKEN.test(token)) await redis().del(sessionKey(token));
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
