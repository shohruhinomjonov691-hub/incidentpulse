import { lookup } from "node:dns/promises";
import type { DeepApiTarget } from "@incidentpulse/config";
import {
  fetchProbeResponse,
  type HttpProbeResult,
  httpProbe,
  isAllowedTarget,
} from "@incidentpulse/mcp-infra";
import type { DeepCategory, ProjectId } from "@incidentpulse/schemas";

/**
 * LLM-free "deep" health: the page answered 200, but is it usable? Two read-only checks:
 *  1. mixed content: an https page that pulls `http://` resources, or whose own JS bundles point at the
 *     project's domains / the server's IP over `http://` or `ws://` (the browser blocks those silently);
 *  2. API: configured endpoints must answer with an expected status.
 * Everything fetched is data. It is only scanned for URLs; nothing is executed and nothing reaches an LLM.
 */

export const DEEP_LIMITS = {
  /** The HTML shell of a page. */
  htmlBytes: 2 * 1024 * 1024,
  /** One first-party JS bundle. A bigger one is skipped. */
  bundleBytes: 5 * 1024 * 1024,
  /** All bundles of one project in one run. */
  totalBundleBytes: 10 * 1024 * 1024,
  bundlesPerRun: 20,
  findings: 20,
  timeoutMs: 15_000,
} as const;

export interface DeepFinding {
  category: DeepCategory;
  /** mixed_content: the insecure URL found. api_down: the API URL that failed. */
  url: string;
  /** mixed_content: the file it was found in (the page or a JS bundle). */
  file?: string;
  /** api_down: what went wrong. mixed_content in HTML: which tag. */
  detail?: string;
}

export interface DeepResult {
  findings: DeepFinding[];
  /**
   * False when something could not be examined (network error, 5xx, timeout), so the lack of findings
   * proves nothing: the caller must not report a recovery on it.
   */
  complete: boolean;
  /** Human-readable notes for the log: skipped files and why. Never sent to Telegram. */
  notes: string[];
}

/** Namespace and spec URLs that are strings, not requests. */
const STANDARD_HOSTS = [
  "w3.org",
  "xmlsoap.org",
  "openxmlformats.org",
  "purl.org",
  "xmlns.com",
  "ns.adobe.com",
  "opengis.net",
  "schema.org",
  "sitemaps.org",
  "ogp.me",
];

const isStandardHost = (host: string) =>
  STANDARD_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));

/** `<link rel=...>` values that name a relation, not a resource the page loads. */
const NON_LOADING_REL =
  /^(canonical|alternate|author|license|help|next|prev|search|dns-prefetch|preconnect)$/;

/** A URL goes into a Telegram message: keep it printable ASCII, no spaces, and short. */
function clean(text: string, max = 180): string {
  return text.replace(/[^\x21-\x7e]/g, "").slice(0, max);
}

/** Same for a short free-text note (it may contain spaces). */
function cleanText(text: string, max = 120): string {
  return text.replace(/[^\x20-\x7e]/g, "").slice(0, max);
}

const hostOf = (entry: string): string | undefined => {
  try {
    return new URL(`https://${entry}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------------------------ fetching

export interface Fetched {
  status?: number;
  finalUrl?: string;
  contentType?: string;
  body?: string;
  bytes?: number;
  /** Over the size limit: not an error, the file is just skipped. */
  tooLarge?: boolean;
  error?: string;
}

const MAX_REDIRECTS = 5;

function errorCode(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (e as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "ETIMEDOUT";
    e = (e as { cause?: unknown }).cause;
  }
  return "FETCH_ERROR";
}

/**
 * GET that reads the body, with a hard size cap and a deadline for the whole exchange. Redirects are
 * followed by hand and only inside the allowlist. The cap counts DECODED bytes, so a compressed
 * response cannot inflate past it.
 */
export async function fetchText(
  url: string,
  options: {
    allowedHosts: readonly string[];
    maxBytes: number;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
  },
): Promise<Fetched> {
  const doFetch = options.fetchImpl ?? fetchProbeResponse;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { error: "INVALID_URL" };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(current.protocol) || current.username || current.password) {
      return { error: "UNSUPPORTED_URL" };
    }
    const port = Number(current.port || (current.protocol === "https:" ? 443 : 80));
    if (!isAllowedTarget(current.hostname, port, options.allowedHosts)) {
      return { error: "HOST_NOT_ALLOWED" };
    }
    try {
      const response = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        signal: deadline,
        headers: { "user-agent": "incidentpulse-deep-health/0 (read-only)", accept: "*/*" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        current = new URL(location, current);
        continue;
      }
      const base = {
        status: response.status,
        finalUrl: current.href,
        contentType: response.headers.get("content-type") ?? "",
      };
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ...base, tooLarge: true };
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ...base, tooLarge: true };
        }
        chunks.push(value);
      }
      return { ...base, bytes, body: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      return { error: errorCode(error) };
    }
  }
  return { error: "TOO_MANY_REDIRECTS" };
}

// ------------------------------------------------------------------------------------ scanning

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export interface HtmlScan {
  /** http:// resources the page itself references. */
  insecure: Array<{ url: string; tag: string }>;
  /** Every <script src>, resolved: bundle candidates. */
  scripts: string[];
}

/** `<script src>`, `<link href>` and `<img src>` of an HTML document. Comments and inline scripts are ignored. */
export function scanHtml(html: string, pageUrl: string): HtmlScan {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1");
  const insecure: HtmlScan["insecure"] = [];
  const scripts: string[] = [];
  for (const [, tag = "", attributes = ""] of stripped.matchAll(/<(script|link|img)\b([^>]*)>/gi)) {
    const name = tag.toLowerCase();
    const raw = attribute(attributes, name === "link" ? "href" : "src")
      ?.replace(/&amp;/gi, "&")
      .trim();
    if (!raw) continue;
    if (name === "link") {
      const rels = (attribute(attributes, "rel") ?? "").toLowerCase().split(/\s+/);
      if (rels.length > 0 && rels.every((rel) => NON_LOADING_REL.test(rel))) continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (name === "script" && /^https?:$/.test(resolved.protocol)) scripts.push(resolved.href);
    if (resolved.protocol === "http:" && !isStandardHost(resolved.hostname.toLowerCase())) {
      insecure.push({ url: resolved.href, tag: name === "link" ? "<link href>" : `<${name} src>` });
    }
  }
  return { insecure, scripts };
}

/** Plain-text `http://` and `ws://` URLs. Template holes, quotes and whitespace end a match. */
const INSECURE_URL = /\b(?:http|ws):\/\/[^\s"'`\\<>(){}[\],;$|^]+/gi;

/** Insecure URLs in a script that point at the project: its domains or the server's IPs. */
export function scanScript(source: string, firstParty: (hostname: string) => boolean): string[] {
  const found = new Set<string>();
  for (const [match] of source.matchAll(INSECURE_URL)) {
    let url: URL;
    try {
      url = new URL(match.replace(/[.:]+$/, ""));
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isStandardHost(host) || !firstParty(host)) continue;
    found.add(url.href);
  }
  return [...found];
}

// ------------------------------------------------------------------------------------ checker

export interface DeepCheckerOptions {
  /** Project domains (the same allowlist the plain poller uses). */
  allowedHosts: Record<ProjectId, string[]>;
  apis: Partial<Record<ProjectId, DeepApiTarget>>;
  probe?: (
    url: string,
    options: { timeoutMs: number; allowedHosts: string[] },
  ) => Promise<HttpProbeResult>;
  fetchImpl?: typeof fetch;
  /** The server's addresses, so `http://203.0.113.7:3003` counts as the project. Default: DNS. */
  resolveIps?: (hostname: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** A failing API is checked once more after this delay before it counts. */
  confirmDelayMs?: number;
}

async function resolveByDns(hostname: string): Promise<string[]> {
  try {
    return (await lookup(hostname, { all: true })).map((entry) => entry.address.toLowerCase());
  } catch {
    return [];
  }
}

export function createDeepChecker(options: DeepCheckerOptions) {
  const probe = options.probe ?? ((url, o) => httpProbe(url, o));
  const resolveIps = options.resolveIps ?? resolveByDns;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEEP_LIMITS.timeoutMs;
  const confirmDelayMs = options.confirmDelayMs ?? 10_000;

  async function mixedContent(project: ProjectId, urls: string[]) {
    const allowedHosts = options.allowedHosts[project];
    const findings: DeepFinding[] = [];
    const notes: string[] = [];
    let complete = true;
    const scanned = new Set<string>();
    let budget: number = DEEP_LIMITS.totalBundleBytes;
    let firstParty: ((hostname: string) => boolean) | undefined;

    const matcher = async () => {
      if (firstParty) return firstParty;
      const domains = [...new Set(allowedHosts.map(hostOf).filter((h): h is string => !!h))];
      const ips = new Set(
        (await Promise.all(domains.map((d) => resolveIps(d)))).flat().map((ip) => ip.toLowerCase()),
      );
      firstParty = (host) =>
        domains.some((d) => host === d || host.endsWith(`.${d}`)) || ips.has(host);
      return firstParty;
    };

    for (const url of urls) {
      const page = await fetchText(url, {
        allowedHosts,
        maxBytes: DEEP_LIMITS.htmlBytes,
        timeoutMs,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const host = clean(new URL(url).host, 80);
      if (page.error || (page.status ?? 0) >= 500) {
        complete = false;
        notes.push(`${host}: page not examined (${page.error ?? `HTTP ${page.status}`})`);
        continue;
      }
      if (page.tooLarge) {
        notes.push(`${host}: page over ${DEEP_LIMITS.htmlBytes} bytes, skipped`);
        continue;
      }
      if (
        !page.finalUrl ||
        !/^2/.test(String(page.status)) ||
        !/html/i.test(page.contentType ?? "") ||
        page.body === undefined
      ) {
        notes.push(`${host}: HTTP ${page.status}, not an HTML page: nothing to scan`);
        continue;
      }
      // Mixed content needs a secure page; on a plain http:// page there is nothing to mix.
      if (new URL(page.finalUrl).protocol !== "https:") {
        notes.push(`${host}: page is not https, mixed content does not apply`);
        continue;
      }
      const html = scanHtml(page.body, page.finalUrl);
      for (const item of html.insecure) {
        findings.push({
          category: "mixed_content",
          url: clean(item.url),
          file: clean(page.finalUrl),
          detail: item.tag,
        });
      }

      const isFirstParty = await matcher();
      for (const script of [...new Set(html.scripts)]) {
        if (scanned.has(script)) continue;
        const target = new URL(script);
        const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
        // Foreign scripts (CDNs, analytics) are not ours to download or judge.
        if (!isAllowedTarget(target.hostname, port, allowedHosts)) continue;
        if (scanned.size >= DEEP_LIMITS.bundlesPerRun || budget <= 0) {
          notes.push(`${host}: bundle limit reached, ${clean(script, 100)} not scanned`);
          continue;
        }
        scanned.add(script);
        const bundle = await fetchText(script, {
          allowedHosts,
          maxBytes: Math.min(DEEP_LIMITS.bundleBytes, budget),
          timeoutMs,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        if (bundle.error || (bundle.status ?? 0) >= 500) {
          complete = false;
          notes.push(
            `${clean(script, 100)}: not scanned (${bundle.error ?? `HTTP ${bundle.status}`})`,
          );
          continue;
        }
        if (bundle.tooLarge) {
          notes.push(`${clean(script, 100)}: over the size limit, skipped`);
          continue;
        }
        if (!/^2/.test(String(bundle.status)) || bundle.body === undefined) {
          notes.push(`${clean(script, 100)}: HTTP ${bundle.status}, skipped`);
          continue;
        }
        budget -= bundle.bytes ?? 0;
        for (const found of scanScript(bundle.body, isFirstParty)) {
          findings.push({
            category: "mixed_content",
            url: clean(found),
            file: clean(bundle.finalUrl ?? script),
            detail: "script",
          });
        }
      }
    }
    return { findings, complete, notes };
  }

  async function api(project: ProjectId): Promise<DeepFinding[]> {
    const target = options.apis[project];
    if (!target || target.api.length === 0) return [];
    // The configured URLs are operator-approved (config checked them against the project's domains), so
    // each is allowed exactly as written, including its own port.
    const allowedHosts = [
      ...options.allowedHosts[project],
      ...target.api.map((raw) => {
        const url = new URL(raw);
        return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
      }),
    ];
    const look = async (urls: string[]) => {
      const failures: DeepFinding[] = [];
      for (const url of urls) {
        const result = await probe(url, { timeoutMs, allowedHosts });
        const problem = !result.completed
          ? (result.error ?? "no response")
          : target.expect.includes(result.status ?? 0)
            ? undefined
            : `HTTP ${result.status} (kutilgan: ${target.expect.join(", ")})`;
        if (problem)
          failures.push({ category: "api_down", url: clean(url), detail: cleanText(problem) });
      }
      return failures;
    };
    let failures = await look(target.api);
    if (failures.length > 0) {
      await sleep(confirmDelayMs);
      const failing = new Set(failures.map((f) => f.url));
      failures = await look(target.api.filter((raw) => failing.has(clean(raw))));
    }
    return failures;
  }

  return {
    /** `urls` are the project's plain-poll URLs (its pages); API URLs come from the configuration. */
    async check(project: ProjectId, urls: string[]): Promise<DeepResult> {
      const page = await mixedContent(project, urls);
      const failures = await api(project);
      return {
        findings: [...page.findings, ...failures].slice(0, DEEP_LIMITS.findings),
        complete: page.complete,
        notes: page.notes,
      };
    },
  };
}

export type DeepChecker = ReturnType<typeof createDeepChecker>;
