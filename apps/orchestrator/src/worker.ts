import { describeError, type Redactor } from "@incidentpulse/redact";
import {
  INCIDENT_JOB_OPTIONS,
  INCIDENT_QUEUE_NAME,
  IncidentJobSchema,
  type ProjectId,
  ProjectIdSchema,
} from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  HEALTH_POLL_EVERY_MINUTES,
  HEALTH_POLL_JOB,
  HEALTH_POLL_SCHEDULER,
  type HealthPoller,
} from "./health-poller.ts";
import {
  DAILY_RECHECK_SCHEDULER_NAME,
  type InvestigationPolicy,
  MANUAL_JOB_NAME,
  SCHEDULED_JOB_NAME,
  WEEKLY_SCHEDULER_NAME,
} from "./investigation-policy.ts";
import type { Logger } from "./log.ts";
import { hashFacts } from "./primary-evidence.ts";
import { formatFailureNotice } from "./report.ts";
import type { ResumeRequest } from "./run.ts";
import { SEOUL_TIMEZONE } from "./weekly-budget.ts";

export interface WorkerOptions {
  redisUrl: string;
  investigations: InvestigationPolicy;
  investigateMode: "on_change" | "weekly";
  notifier: Notifier;
  redact: Redactor;
  log: Logger;
  queueName?: string;
  onResume?(request: ResumeRequest): Promise<void>;
  /** LLM-free health poller, run every 15 minutes inside the single-concurrency worker. */
  healthPoller?: HealthPoller;
}

/** The shared queue serializes observation, scheduling, and investigation across worker processes. */
export async function createIncidentWorker(options: WorkerOptions) {
  const { investigations, notifier, redact, log } = options;
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queueName = options.queueName ?? INCIDENT_QUEUE_NAME;
  const queue = new Queue(queueName, { connection });
  await queue.setGlobalConcurrency(1);
  const weekly = options.investigateMode === "weekly";
  const schedulerName = weekly ? WEEKLY_SCHEDULER_NAME : DAILY_RECHECK_SCHEDULER_NAME;
  await queue.removeJobScheduler(weekly ? DAILY_RECHECK_SCHEDULER_NAME : WEEKLY_SCHEDULER_NAME);
  await queue.upsertJobScheduler(
    schedulerName,
    {
      pattern: weekly ? "0 0 9 * * 0" : "0 0 9 * * *",
      tz: SEOUL_TIMEZONE,
    },
    { name: schedulerName, opts: INCIDENT_JOB_OPTIONS },
  );

  // The poller runs as a job of this queue, so it is serialized with investigations (global concurrency 1).
  if (options.healthPoller) {
    await queue.upsertJobScheduler(
      HEALTH_POLL_SCHEDULER,
      { pattern: `0 */${HEALTH_POLL_EVERY_MINUTES} * * * *` },
      {
        name: HEALTH_POLL_JOB,
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 86_400 } },
      },
    );
    // Look once right after a start (a restart must not hide an outage for up to 15 minutes).
    await queue.add(
      HEALTH_POLL_JOB,
      {},
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
        jobId: `${HEALTH_POLL_JOB}-boot-${Date.now()}`,
      },
    );
  } else {
    await queue.removeJobScheduler(HEALTH_POLL_SCHEDULER);
  }

  const RESUME_JOB = "graph-resume";
  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name === HEALTH_POLL_JOB) {
        await options.healthPoller?.run();
        return;
      }
      if (job.name === WEEKLY_SCHEDULER_NAME || job.name === DAILY_RECHECK_SCHEDULER_NAME) {
        if (job.name !== schedulerName) return;
        const active = await investigations.active();
        await queue.addBulk(
          active.map((data) => ({
            name: SCHEDULED_JOB_NAME,
            data,
            opts: {
              ...INCIDENT_JOB_OPTIONS,
              jobId: `${schedulerName}-${hashFacts([job.id, data.project, data.signal.check]).slice(0, 32)}`,
            },
          })),
        );
        log.info("scheduled signals queued", {
          incidents: active.length,
          mode: options.investigateMode,
        });
        return;
      }
      if (job.name === RESUME_JOB) {
        await options.onResume?.(job.data as ResumeRequest);
        return;
      }
      if (job.name === MANUAL_JOB_NAME) {
        const project = ProjectIdSchema.parse(job.data.project);
        const incidentId = job.id as string;
        const outcome = await investigations.manual(project, incidentId);
        log.info("manual investigation finished", { incidentId, project, outcome });
        return;
      }
      if (job.name === SCHEDULED_JOB_NAME && !job.id?.startsWith(`${schedulerName}-`)) return;
      const parsed = IncidentJobSchema.parse(job.data);
      const outcome =
        job.name === SCHEDULED_JOB_NAME
          ? await investigations.scheduled(parsed, job.id as string)
          : await investigations.monitor(parsed);
      log.info("incident finished", {
        incidentId: parsed.incidentId,
        project: parsed.project,
        outcome,
      });
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", async (job, error) => {
    const incidentId =
      job?.name === MANUAL_JOB_NAME || job?.name === SCHEDULED_JOB_NAME
        ? job.id
        : job?.data.incidentId;
    log.error("incident attempt failed", {
      incidentId,
      attempt: job?.attemptsMade,
      error: describeError(error, redact),
    });
    const project = ProjectIdSchema.safeParse(job?.data.project);
    if (job && incidentId && project.success && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      try {
        await notifier.send(formatFailureNotice(project.data, incidentId));
      } catch (notifyError) {
        log.error("failure notice not delivered", { error: describeError(notifyError, redact) });
      }
    }
  });
  worker.on("error", (error) => log.error("worker error", { error: describeError(error, redact) }));

  return {
    async enqueueResume(request: ResumeRequest) {
      await queue.add(RESUME_JOB, request, {
        ...INCIDENT_JOB_OPTIONS,
        jobId: `resume-${hashFacts([request.incidentId, request.approvalId]).slice(0, 32)}`,
        removeOnComplete: true,
        removeOnFail: true,
      });
    },
    async enqueueManual(project: ProjectId, updateId: number) {
      await queue.add(
        MANUAL_JOB_NAME,
        { project },
        { ...INCIDENT_JOB_OPTIONS, jobId: `manual-${updateId}` },
      );
    },
    async close() {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}
