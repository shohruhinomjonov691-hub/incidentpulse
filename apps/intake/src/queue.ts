import { createHash } from "node:crypto";
import {
  INCIDENT_JOB_OPTIONS,
  INCIDENT_QUEUE_NAME,
  type IncidentJob,
} from "@incidentpulse/schemas";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { IncidentQueue } from "./server.ts";

export interface BullIncidentQueue extends IncidentQueue {
  close(): Promise<void>;
}

/** A retransmission can be dropped. Distinct observations must reach the worker in order. */
export function observationKey(job: IncidentJob): string {
  const { check, level, summary, at } = job.signal;
  return createHash("sha256")
    .update(JSON.stringify([job.project, check, level, summary, at, job.category]))
    .digest("hex");
}
export function createBullQueue(options: {
  redisUrl: string;
  queueName?: string;
}): BullIncidentQueue {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<IncidentJob>(options.queueName ?? INCIDENT_QUEUE_NAME, { connection });

  return {
    async enqueue(job) {
      const added = await queue.add("incident", job, {
        jobId: job.incidentId,
        ...INCIDENT_JOB_OPTIONS,
        deduplication: { id: observationKey(job), ttl: 600_000 },
      });
      // On a duplicate BullMQ returns the *existing* job id (the data on the object is ours).
      const id = added.id ?? job.incidentId;
      return { incidentId: id, deduplicated: id !== job.incidentId };
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
