import { isAllowedHost } from "../allowlist.ts";
import { type HttpProbeResult, HttpProbeResultSchema } from "../schemas.ts";

const MAX_REDIRECTS = 5;
const TLS_ERROR =
  /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|EPROTO)/;

function errorCode(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (
      (e as { name?: unknown }).name === "TimeoutError" ||
      (e as { name?: unknown }).name === "AbortError"
    ) {
      return "ETIMEDOUT";
    }
    e = (e as { cause?: unknown }).cause;
  }
  return "FETCH_ERROR";
}

export interface HttpProbeOptions {
  timeoutMs: number;
  allowedHosts: readonly string[];
  fetchImpl?: typeof fetch;
}

/** GET without reading the body. Redirects are followed manually and only within the allowlist. */
export async function httpProbe(url: string, options: HttpProbeOptions): Promise<HttpProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const started = Date.now();
  const redirects: HttpProbeResult["redirects"] = [];
  const done = (r: Omit<HttpProbeResult, "latencyMs" | "redirects" | "url">) =>
    HttpProbeResultSchema.parse({ url, redirects, latencyMs: Date.now() - started, ...r });

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return done({ completed: false, error: "INVALID_URL" });
  }

  const deadline = AbortSignal.timeout(options.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(current.protocol) || current.username || current.password) {
      return done({ completed: false, error: "UNSUPPORTED_URL" });
    }
    if (!isAllowedHost(current.hostname, options.allowedHosts)) {
      return done({ completed: false, error: "HOST_NOT_ALLOWED", blockedRedirect: current.origin });
    }
    let response: Response;
    try {
      response = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        signal: deadline,
        headers: { "user-agent": "incidentpulse-probe/0 (read-only)" },
      });
    } catch (error) {
      const code = errorCode(error);
      return done({
        completed: false,
        error: code,
        ...(TLS_ERROR.test(code) ? { certErrorCode: code } : {}),
      });
    }
    await response.body?.cancel().catch(() => undefined);

    const location = response.headers.get("location") ?? undefined;
    if (response.status >= 300 && response.status < 400 && location) {
      redirects.push({ url: current.href, status: response.status, location });
      try {
        current = new URL(location, current);
      } catch {
        return done({
          completed: true,
          status: response.status,
          finalUrl: current.href,
          error: "BAD_REDIRECT",
        });
      }
      if (hop === MAX_REDIRECTS) {
        return done({
          completed: true,
          status: response.status,
          finalUrl: current.href,
          error: "TOO_MANY_REDIRECTS",
        });
      }
      continue;
    }
    return done({ completed: true, status: response.status, finalUrl: current.href });
  }
  return done({ completed: false, error: "TOO_MANY_REDIRECTS" });
}
