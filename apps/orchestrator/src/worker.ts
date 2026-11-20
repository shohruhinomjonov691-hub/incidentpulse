import { describeError, type Redactor } from "@incidentpulse/redact";
import { INCIDENT_QUEUE_NAME, type IncidentJob, IncidentJobSchema } from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { IncidentGraph } from "./graph.ts";
import type { Logger } from "./log.ts";
import { formatFailureNotice } from "./report.ts";
import { runIncident } from "./run.ts";

export interface WorkerOptions {
  redisUrl: string;
  graph: IncidentGraph;
  notifier: Notifier;
  redact: Redactor;
  log: Logger;
  queueName?: string;
}

/** BullMQ consumer. Concurrency 1: one investigation at a time (per-project limit comes later). */
export function createIncidentWorker(options: WorkerOptions): { close(): Promise<void> } {
  const { graph, notifier, redact, log } = options;
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<IncidentJob>(
    options.queueName ?? INCIDENT_QUEUE_NAME,
    async (job) => {
      const parsed = IncidentJobSchema.parse(job.data);
      log.info("incident started", { incidentId: parsed.incidentId, project: parsed.project });
      const outcome = await runIncident(graph, parsed);
      log.info("incident finished", {
        incidentId: parsed.incidentId,
        mode: outcome.mode,
        costUsd: Number((outcome.state.costUsd ?? 0).toFixed(6)),
        hypotheses: outcome.state.hypotheses?.length ?? 0,
        escalated: outcome.state.escalation?.reason ?? null,
      });
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", async (job, error) => {
    log.error("incident attempt failed", {
      incidentId: job?.data.incidentId,
      attempt: job?.attemptsMade,
      error: describeError(error, redact),
    });
    // Final failure: tell the human once. Details stay in the logs (redacted).
    const finalAttempt = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (job && finalAttempt) {
      try {
        await notifier.send(formatFailureNotice(job.data.project, job.data.incidentId));
      } catch (notifyError) {
        log.error("failure notice not delivered", { error: describeError(notifyError, redact) });
      }
    }
  });
  worker.on("error", (error) => log.error("worker error", { error: describeError(error, redact) }));

  return {
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}
