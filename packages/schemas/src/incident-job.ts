import { z } from "zod";
import { type Category, type ProjectId, ProjectIdSchema, SignalSchema } from "./incident-state.ts";

/** BullMQ queue between apps/intake (producer) and apps/orchestrator (worker). */
export const INCIDENT_QUEUE_NAME = "incident-intake";

/** Display names used in human-facing messages. */
export const PROJECT_DISPLAY_NAMES: Record<ProjectId, string> = {
  gotrip: "GoTrip",
  kervan: "Kervan",
  "camera-studio": "Camera Studio",
  codetrail: "CodeTrail",
  findit: "FindIt",
  "food-lens": "Food Lens",
};

/**
 * Body of POST /webhook/monitor (SPEC §12): {project, check, level, summary, at}.
 * Length limits keep untrusted text from flooding prompts.
 */
export const MonitorWebhookSchema = z.strictObject({
  project: ProjectIdSchema,
  check: z.string().min(1).max(100),
  level: z.string().min(1).max(50),
  summary: z.string().max(1000),
  at: SignalSchema.shape.at,
});
export type MonitorWebhook = z.infer<typeof MonitorWebhookSchema>;

export const IncidentJobSchema = z.strictObject({
  incidentId: z.string().min(1),
  project: ProjectIdSchema,
  signal: SignalSchema,
  dedupKey: z.string().min(1),
  receivedAt: z.iso.datetime(),
});
export type IncidentJob = z.infer<typeof IncidentJobSchema>;

/** Dedup key from SPEC §3.2: `project:check:category`. Category is not known at intake. */
export function dedupKey(
  project: ProjectId,
  check: string,
  category: Category = "unknown",
): string {
  return `${project}:${check}:${category}`;
}
