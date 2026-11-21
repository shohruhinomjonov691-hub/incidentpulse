import { randomBytes } from "node:crypto";
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
import type { Logger } from "./log.ts";

export const HEALTH_POLL_JOB = "health-poll";
export const HEALTH_POLL_SCHEDULER = "health-poll-every-15-minutes";
export const HEALTH_POLL_EVERY_MINUTES = 15;
/** The `check` name on the signals the poller raises. */
export const HEALTH_POLL_CHECK = "health_poll";

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
}

interface ProjectState {
  level: "ok" | "down";
  since: string;
  checkedAt: string;
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

  return {
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
