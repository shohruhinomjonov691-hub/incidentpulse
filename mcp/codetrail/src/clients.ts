import type { Redactor } from "@incidentpulse/redact";
import {
  type CodetrailResult,
  CodetrailResultSchema,
  type CommitsResult,
  CommitsResultSchema,
} from "./schemas.ts";

export const MAX_EXCERPT_CHARS = 4000;
const MAX_BODY_BYTES = 256 * 1024;

export interface CodetrailConfig {
  /** CodeTrail base URL, e.g. https://codetrail.example. Unset = not configured. */
  baseUrl?: string | undefined;
  /** Optional Bearer key (CodeTrail's monitor endpoints need one; search/explain are public). */
  apiKey?: string | undefined;
  /** Our project id -> CodeTrail project_id (identity when absent). */
  projectIds?: Record<string, string> | undefined;
  /** Fine-grained, read-only GitHub token (Contents: read / Metadata: read). Unset = not configured. */
  githubToken?: string | undefined;
  /** Our project id -> "owner/repo". */
  repos?: Record<string, string> | undefined;
  githubApiBase?: string | undefined;
  timeoutMs: number;
  redact: Redactor;
  fetchImpl?: typeof fetch | undefined;
}

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

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

function excerptOf(text: string, redact: Redactor): string {
  const redacted = redact(text.trim());
  return redacted.length > MAX_EXCERPT_CHARS
    ? `${redacted.slice(0, MAX_EXCERPT_CHARS)}…`
    : redacted;
}

/** POST {baseUrl}/api/search | /api/explain with {project_id, question}. */
export async function callCodetrail(
  endpoint: "search" | "explain",
  project: string,
  question: string,
  config: CodetrailConfig,
): Promise<CodetrailResult> {
  const started = Date.now();
  const done = (r: Omit<CodetrailResult, "project" | "latencyMs">) =>
    CodetrailResultSchema.parse({ project, latencyMs: Date.now() - started, ...r });

  if (!config.baseUrl)
    return done({ status: "not_configured", error: "CODETRAIL_BASE_URL is not set" });

  let url: URL;
  try {
    url = new URL(`/api/${endpoint}`, config.baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("scheme");
  } catch {
    return done({ status: "error", error: "INVALID_BASE_URL" });
  }
  const doFetch = config.fetchImpl ?? fetch;
  try {
    const response = await doFetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "incidentpulse-codetrail/0 (read-only)",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        project_id: config.projectIds?.[project] ?? project,
        question,
        ...(endpoint === "explain" ? { language: "en" } : {}),
      }),
    });
    const body = await readCapped(response);
    return done({
      status: response.ok ? "ok" : "error",
      httpStatus: response.status,
      excerpt: excerptOf(body, config.redact),
      ...(response.ok ? {} : { error: `HTTP_${response.status}` }),
    });
  } catch (error) {
    return done({ status: "error", error: errorCode(error) });
  }
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

interface GithubCommit {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
}

/** GET /repos/{owner}/{repo}/commits (read-only, fine-grained token). */
export async function recentCommits(
  project: string,
  options: { since?: string | undefined; limit: number },
  config: CodetrailConfig,
): Promise<CommitsResult> {
  const started = Date.now();
  const repo = config.repos?.[project];
  const done = (r: Omit<CommitsResult, "project" | "latencyMs">) =>
    CommitsResultSchema.parse({
      project,
      latencyMs: Date.now() - started,
      ...(repo ? { repo } : {}),
      ...r,
    });

  if (!config.githubToken)
    return done({ status: "not_configured", error: "GitHub token is not set" });
  if (!repo || !REPO.test(repo))
    return done({ status: "not_configured", error: "no repository mapped for this project" });

  const base = config.githubApiBase ?? "https://api.github.com";
  const url = new URL(`/repos/${repo}/commits`, base);
  url.searchParams.set("per_page", String(Math.min(20, Math.max(1, Math.floor(options.limit)))));
  if (options.since) url.searchParams.set("since", options.since);

  const doFetch = config.fetchImpl ?? fetch;
  try {
    const response = await doFetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.githubToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "incidentpulse-codetrail/0 (read-only)",
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return done({
        status: "error",
        httpStatus: response.status,
        error: `HTTP_${response.status}`,
      });
    }
    const rows = JSON.parse(await readCapped(response)) as GithubCommit[];
    const commits = rows.slice(0, 20).map((r) => ({
      sha: (r.sha ?? "").slice(0, 7),
      message: config.redact((r.commit?.message ?? "").split("\n")[0]?.slice(0, 200) ?? ""),
      ...(r.commit?.author?.name ? { author: config.redact(r.commit.author.name) } : {}),
      ...(r.commit?.author?.date ? { date: r.commit.author.date } : {}),
    }));
    return done({ status: "ok", httpStatus: response.status, commits });
  } catch (error) {
    return done({ status: "error", error: errorCode(error) });
  }
}
