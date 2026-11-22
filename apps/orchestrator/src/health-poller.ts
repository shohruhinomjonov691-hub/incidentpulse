import { createHash, randomBytes } from "node:crypto";
import { type HttpProbeResult, httpProbe } from "@incidentpulse/mcp-infra";
import type { Redactor } from "@incidentpulse/redact";
import {
  dedupKey,
  type IncidentJob,
  PROJECT_DISPLAY_NAMES,
  type ProjectId,
} from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import type { Redis } from "ioredis";
import type { DeepResult } from "./deep-health.ts";
import type { Logger } from "./log.ts";
import { formatDegraded, formatDegradedRecovered } from "./report.ts";
import { dayKey } from "./weekly-budget.ts";

export const HEALTH_POLL_JOB = "health-poll";
export const HEALTH_POLL_SCHEDULER = "health-poll-every-15-minutes";
export const HEALTH_POLL_EVERY_MINUTES = 15;
/** The `check` name on the signals the poller raises. */
export const HEALTH_POLL_CHECK = "health_poll";
export const HEALTH_DEEP_JOB = "health-deep";
export const HEALTH_DEEP_SCHEDULER = "health-deep-scheduler";

/** Down: nothing usable answers. Degraded: the page answers 200 but a deep check fails. */
export type HealthLevel = "ok" | "degraded" | "down";

export function effectiveLevel(shallow: "ok" | "down", deep: "ok" | "degraded"): HealthLevel {
  return shallow === "down" ? "down" : deep === "degraded" ? "degraded" : "ok";
}

export interface HealthPollerOptions {
  redis: Redis;
  /** Full URLs per project (already validated against the project's domains by the config). */
  targets: Partial<Record<ProjectId, string[]>>;
  /** Host allowlist per project; `httpProbe` refuses anything outside it (also on redirects). */
  allowedHosts: Record<ProjectId, string[]>;
  notifier: Notifier;
  redact: Redactor;
  /** The investigation policy's `monitor`: dedup, change detection, cache and the LLM budget live there. */
  monitor(job: IncidentJob): Promise<string>;
  log?: Logger;
  prefix?: string;
  probe?: (
    url: string,
    options: { timeoutMs: number; allowedHosts: string[] },
  ) => Promise<HttpProbeResult>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** A failing check is repeated once after this delay before the project is called Down. */
  confirmDelayMs?: number;
  /** LLM-free deep checks (mixed content, API). Without it `runDeep` does nothing. */
  deep?: { check(project: ProjectId, urls: string[]): Promise<DeepResult> };
}

interface ProjectState {
  level: "ok" | "down";
  since: string;
  checkedAt: string;
}

interface DeepState {
  level: "ok" | "degraded";
  since: string;
  checkedAt: string;
  /** Hash of the findings: a change means new evidence and a new message. */
  fingerprint?: string;
  /** Seoul day of the last message: an unchanged Degraded repeats at most once per day. */
  notifiedDay?: string;
}

/** Down when nothing answers, TLS fails, or the server answers 5xx. 4xx is the app talking: not an outage. */
export function failureOf(url: string, result: HttpProbeResult): string | undefined {
  const host = new URL(url).host;
  if (!result.completed) return `${host}: ${result.certErrorCode ?? result.error ?? "no response"}`;
  if ((result.status ?? 0) >= 500) return `${host}: HTTP ${result.status}`;
  return undefined;
}

/**
 * LLM-free health poller. It only looks (one GET per URL, body never read) and hands a signal to the
 * investigation policy when a project's level CHANGES: ok to down, down to ok, or a first look that
 * finds it down. A project that stays down raises nothing, so it costs no tokens and no messages.
 */
export function createHealthPoller(options: HealthPollerOptions) {
  const { redis, notifier, redact } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = options.probe ?? ((url, o) => httpProbe(url, o));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const confirmDelayMs = options.confirmDelayMs ?? 10_000;
  const stateKey = `${options.prefix ?? "incidentpulse:health"}:state`;
  const deepKey = `${options.prefix ?? "incidentpulse:health"}:deep`;

  async function lookAt(project: ProjectId, urls: string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const url of urls) {
      const result = await probe(url, { timeoutMs, allowedHosts: options.allowedHosts[project] });
      const failure = failureOf(url, result);
      if (failure) failures.push(failure);
    }
    return failures;
  }

  async function check(project: ProjectId, urls: string[]) {
    let failures = await lookAt(project, urls);
    if (failures.length > 0) {
      await sleep(confirmDelayMs);
      failures = await lookAt(project, urls);
    }
    return failures;
  }

  async function load(project: ProjectId): Promise<ProjectState | undefined> {
    const raw = await redis.hget(stateKey, project);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as ProjectState;
      return parsed.level === "ok" || parsed.level === "down" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function loadDeep(project: ProjectId): Promise<DeepState | undefined> {
    const raw = await redis.hget(deepKey, project);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as DeepState;
      return parsed.level === "ok" || parsed.level === "degraded" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One deep look at one project. Findings -> Degraded (a message on a change, a reminder at most once
   * per Seoul day while unchanged). No findings -> ok, with a recovery message if it was Degraded. If
   * something could not be examined, nothing is concluded. Never calls an LLM and never proposes a fix.
   */
  async function deepCheck(project: ProjectId, urls: string[]): Promise<HealthLevel | undefined> {
    if (!options.deep) return undefined;
    const result = await options.deep.check(project, urls);
    for (const note of result.notes) options.log?.info("deep health note", { project, note });
    const previous = await loadDeep(project);
    const at = now();
    if (result.findings.length === 0) {
      if (!result.complete) return previous?.level;
      if (previous?.level === "degraded") {
        await notifier.send(formatDegradedRecovered(project));
      }
      const state: DeepState = {
        level: "ok",
        since: previous?.level === "ok" ? previous.since : at.toISOString(),
        checkedAt: at.toISOString(),
      };
      await redis.hset(deepKey, project, JSON.stringify(state));
      return "ok";
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          result.findings.map((f) => [f.category, f.url, f.file ?? "", f.detail ?? ""]).sort(),
        ),
      )
      .digest("hex");
    const changed = previous?.level !== "degraded" || previous.fingerprint !== fingerprint;
    const today = dayKey(at);
    let notifiedDay = previous?.notifiedDay;
    if (changed || notifiedDay !== today) {
      await notifier.send(
        redact(formatDegraded({ project, findings: result.findings, reminder: !changed })),
      );
      notifiedDay = today;
    }
    const state: DeepState = {
      level: "degraded",
      since: previous?.level === "degraded" ? previous.since : at.toISOString(),
      checkedAt: at.toISOString(),
      fingerprint,
      ...(notifiedDay ? { notifiedDay } : {}),
    };
    await redis.hset(deepKey, project, JSON.stringify(state));
    return "degraded";
  }

  return {
    /** Deep checks for every project that is not Down. Runs on its own (slower) schedule. */
    async runDeep() {
      const levels: Array<{ project: ProjectId; level: HealthLevel }> = [];
      for (const [project, urls] of Object.entries(options.targets) as Array<
        [ProjectId, string[]]
      >) {
        if (urls.length === 0 || !options.deep) continue;
        try {
          // A project that is Down is the plain poller's business: its page cannot be examined anyway.
          if ((await load(project))?.level === "down") continue;
          const level = await deepCheck(project, urls);
          if (level) levels.push({ project, level });
        } catch (error) {
          options.log?.error("deep health failed for a project", {
            project,
            error: error instanceof Error ? redact(error.message) : "unknown",
          });
        }
      }
      const degraded = levels.filter((l) => l.level === "degraded").length;
      options.log?.info("deep health finished", { checked: levels.length, degraded });
      return { checked: levels.length, degraded, levels };
    },

    async run() {
      const changes: Array<{ project: ProjectId; level: "ok" | "down"; outcome: string }> = [];
      let checked = 0;
      for (const [project, urls] of Object.entries(options.targets) as Array<
        [ProjectId, string[]]
      >) {
        if (urls.length === 0) continue;
        try {
          const failures = await check(project, urls);
          checked += 1;
          const level = failures.length === 0 ? "ok" : "down";
          const previous = await load(project);
          const at = now();
          const changed = previous ? previous.level !== level : level === "down";
          if (changed) {
            const summary = redact(
              level === "down"
                ? `Health poll: ${failures.join("; ")} (confirmed after ${Math.round(confirmDelayMs / 1000)}s)`
                : `Health poll: ${urls.map((u) => new URL(u).host).join(", ")} answering again`,
            ).slice(0, 900);
            const job: IncidentJob = {
              incidentId: `hp-${at.getTime().toString(36)}-${randomBytes(2).toString("hex")}`,
              project,
              signal: { check: HEALTH_POLL_CHECK, level, summary, at: at.toISOString() },
              dedupKey: dedupKey(project, HEALTH_POLL_CHECK),
              receivedAt: at.toISOString(),
            };
            // If this throws the state is NOT saved, so the next poll raises the same change again.
            const outcome = await options.monitor(job);
            changes.push({ project, level, outcome });
            if (level === "ok" && previous?.level === "down") {
              await notifier.send(
                `🟢 ${PROJECT_DISPLAY_NAMES[project]} — qayta ishlayapti (health poll).`,
              );
              // A page that just came back is exactly when a hidden second fault shows (case study:
              // TLS fixed, then mixed content): look deeper now instead of waiting for the next hour.
              try {
                await deepCheck(project, urls);
              } catch (error) {
                options.log?.error("deep health after recovery failed", {
                  project,
                  error: error instanceof Error ? redact(error.message) : "unknown",
                });
              }
            }
          }
          const state: ProjectState = {
            level,
            since: changed || !previous ? at.toISOString() : previous.since,
            checkedAt: at.toISOString(),
          };
          await redis.hset(stateKey, project, JSON.stringify(state));
        } catch (error) {
          options.log?.error("health poll failed for a project", {
            project,
            error: error instanceof Error ? redact(error.message) : "unknown",
          });
        }
      }
      options.log?.info("health poll finished", { checked, changes: changes.length });
      return { checked, changes };
    },
  };
}

export type HealthPoller = ReturnType<typeof createHealthPoller>;
