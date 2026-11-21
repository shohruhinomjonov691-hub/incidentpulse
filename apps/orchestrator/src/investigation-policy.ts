import type { Redactor } from "@incidentpulse/redact";
import {
  type Category,
  type IncidentJob,
  IncidentJobSchema,
  PROJECT_DISPLAY_NAMES,
  type ProjectId,
  ProjectIdSchema,
} from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import type { Redis } from "ioredis";
import { causeFingerprint } from "./correlate.ts";
import type { GraphState, IncidentGraph } from "./graph.ts";
import { scrubText } from "./guardrails.ts";
import { hashFacts, type PrimaryEvidence } from "./primary-evidence.ts";
import { runIncident } from "./run.ts";
import { dayKey } from "./weekly-budget.ts";

const CACHE_SECONDS = 7 * 86_400;
export const WEEKLY_SCHEDULER_NAME = "weekly-investigations";
export const DAILY_RECHECK_SCHEDULER_NAME = "daily-recheck";
export const SCHEDULED_JOB_NAME = "scheduled-investigation";
export const MANUAL_JOB_NAME = "manual-investigation";

function fingerprint(project: ProjectId, category: Category, primaryHash: string): string {
  return hashFacts([project, category, primaryHash]);
}

function compareObservations(a: IncidentJob, b: IncidentJob): number {
  return (
    Date.parse(a.signal.at) - Date.parse(b.signal.at) ||
    Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
  );
}

export function createInvestigationPolicy(options: {
  redis: Redis;
  graph: IncidentGraph;
  notifier: Notifier;
  redact: Redactor;
  mode: "on_change" | "weekly";
  probe(job: IncidentJob): Promise<PrimaryEvidence>;
  now?: () => Date;
  prefix?: string;
  closeApproval?(project: ProjectId, check: string): Promise<void>;
}) {
  const { redis, graph, notifier, redact, mode, probe } = options;
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? "incidentpulse:investigation";
  const observed = (project: ProjectId) => `${prefix}:observed:${project}`;
  const applied = (project: ProjectId) => `${prefix}:applied:${project}`;
  const cacheKey = (id: string) => `${prefix}:conclusion:${id}`;
  const aliasKey = (id: string) => `${prefix}:resolved:${id}`;

  async function investigate(job: IncidentJob, manual = false) {
    const primary = await probe(job);
    const id = fingerprint(job.project, primary.category, primary.hash);
    const { project, signal } = job;
    if (!manual) {
      const resolved = await redis.get(aliasKey(id));
      const cached = await redis.get(cacheKey(resolved ?? id));
      if (cached !== null) {
        if (
          await redis.set(
            `${prefix}:reminder:${project}:${dayKey(now())}`,
            "1",
            "EX",
            172_800,
            "NX",
          )
        ) {
          await notifier.send(
            `🔴 ${PROJECT_DISPLAY_NAMES[project]} — davom etmoqda, xulosa: ${cached}`,
          );
        }
        await redis.hset(applied(project), signal.check, id);
        return "cached";
      }
      // An unchanged Down still counts as the same episode after its conclusion expires.
      if ((await redis.hget(applied(project), signal.check)) === id) return "unchanged";
    }

    const { state } = await runIncident(graph, job, primary);
    await remember(state, manual);
    await correlate(state);
    return (
      state.escalation?.reason ??
      (state.approval?.status === "pending" ? "awaiting_approval" : "investigated")
    );
  }

  /** Another project went down with the same specific fault within 15 minutes: say so once. */
  async function correlate(state: GraphState) {
    const found = causeFingerprint(state.category, state.evidence);
    if (!found || state.escalation) return;
    const key = `${prefix}:cause:${found}`;
    await redis.hset(key, state.project, state.incidentId);
    await redis.expire(key, 900);
    const peers = Object.keys(await redis.hgetall(key)).filter((p) => p !== state.project);
    if (peers.length === 0) return;
    if (!(await redis.set(`${key}:notified:${state.project}`, "1", "EX", 900, "NX"))) return;
    const names = [state.project, ...peers]
      .map((p) => PROJECT_DISPLAY_NAMES[p as ProjectId] ?? p)
      .join(" + ");
    await notifier.send(
      `🔗 ${names} — bir xil sabab (${state.category}): bitta tuzatish hammasini hal qilishi mumkin.`,
    );
  }

  async function remember(state: GraphState, manual = false) {
    const analyzed = state.primary;
    if (!analyzed) return;
    const { project, signal } = state;
    const from = fingerprint(project, analyzed.category, analyzed.hash);
    const tx = redis.multi();
    const best =
      state.hypotheses.find((h) => h.id === state.verdict?.hypothesisId) ?? state.hypotheses[0];
    const concluded = state.reportSent || state.approval || state.workflowStatus;
    if (concluded && !state.escalation && state.category && best) {
      const found = fingerprint(project, state.category, analyzed.hash);
      const cause = redact(best.cause).slice(0, 240);
      if (manual) {
        tx.set(cacheKey(found), cause, "EX", CACHE_SECONDS);
        tx.set(aliasKey(from), found, "EX", CACHE_SECONDS);
      } else {
        tx.set(cacheKey(found), cause, "EX", CACHE_SECONDS, "NX");
        tx.set(aliasKey(from), found, "EX", CACHE_SECONDS, "NX");
      }
    }
    if (!manual) tx.hset(applied(project), signal.check, from);
    for (const [error] of (await tx.exec()) ?? []) if (error) throw error;
  }

  return {
    remember,
    async monitor(job: IncidentJob) {
      const { project, signal } = job;
      if (signal.level !== "ok" && signal.level !== "down") return "ignored";
      const previous = await redis.hget(observed(project), signal.check);
      if (previous) {
        const prior = IncidentJobSchema.parse(JSON.parse(previous));
        if (compareObservations(job, prior) < 0) return "stale";
      }
      const safeJob = {
        ...job,
        signal: { ...signal, summary: redact(scrubText(signal.summary).text) },
      };
      const tx = redis.multi().hset(observed(project), signal.check, JSON.stringify(safeJob));
      if (signal.level === "ok") {
        tx.hdel(applied(project), signal.check);
      }
      for (const [error] of (await tx.exec()) ?? []) if (error) throw error;
      if (signal.level === "ok") {
        await options.closeApproval?.(project, signal.check);
        return "recovered";
      }
      if (mode === "weekly") return "buffered";
      return investigate(job);
    },

    async active() {
      const entries = await Promise.all(
        ProjectIdSchema.options.map((project) => redis.hvals(observed(project))),
      );
      return entries
        .flat()
        .map((entry) => IncidentJobSchema.parse(JSON.parse(entry)))
        .filter((entry) => entry.signal.level === "down");
    },

    async scheduled(job: IncidentJob, incidentId: string) {
      const latest = await redis.hget(observed(job.project), job.signal.check);
      if (!latest) return "superseded";
      const current = IncidentJobSchema.parse(JSON.parse(latest));
      if (current.signal.level === "ok") return "superseded";
      return investigate({ ...current, incidentId });
    },

    async manual(project: ProjectId, incidentId: string) {
      const history = (await redis.hvals(observed(project)))
        .map((entry) => IncidentJobSchema.parse(JSON.parse(entry)))
        .sort((a, b) => compareObservations(b, a));
      const last = history.find((job) => job.signal.level === "down");
      const at = now().toISOString();
      return investigate(
        {
          incidentId,
          project,
          ...(last?.category ? { category: last.category } : {}),
          signal: last?.signal ?? {
            check: "manual",
            level: "down",
            summary: "On-demand check current project health",
            at,
          },
          dedupKey: `${project}:manual:unknown`,
          receivedAt: at,
        },
        true,
      );
    },
  };
}

export type InvestigationPolicy = ReturnType<typeof createInvestigationPolicy>;
