import { INCIDENT_QUEUE_NAME, type IncidentJob } from "@incidentpulse/schemas";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { IncidentQueue } from "./server.ts";

export interface BullIncidentQueue extends IncidentQueue {
  close(): Promise<void>;
}

/** BullMQ producer. Same project+check inside `dedupTtlMs` collapses into one job (SPEC ADR-009). */
export function createBullQueue(options: {
  redisUrl: string;
  dedupTtlMs: number;
  queueName?: string;
}): BullIncidentQueue {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<IncidentJob>(options.queueName ?? INCIDENT_QUEUE_NAME, { connection });

  return {
    async enqueue(job) {
      const added = await queue.add("incident", job, {
        jobId: job.incidentId,
        // BullMQ job ids and dedup ids must not contain ":".
        deduplication: { id: job.dedupKey.replaceAll(":", "__"), ttl: options.dedupTtlMs },
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
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
