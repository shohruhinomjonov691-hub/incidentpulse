import { z } from "zod";

/**
 * IncidentState: the LangGraph state, exactly as specified in docs/SPEC.md §3.1.
 * Strict objects: unknown keys are rejected so TS and Python cannot drift silently.
 */

// The six monitored apps (SPEC.md header). Id spelling is an assumption: see docs/VERSIONS.md.
export const ProjectIdSchema = z.enum([
  "gotrip",
  "kervan",
  "camera-studio",
  "codetrail",
  "findit",
  "food-lens",
]);

// Initial runbooks (SPEC.md §5.3).
export const RunbookIdSchema = z.enum([
  "certbot_renew",
  "nginx_reload",
  "docker_restart",
  "pm2_restart",
  "docker_compose_up",
]);

export const CategorySchema = z.enum([
  "tls",
  "dns",
  "http_5xx",
  "timeout",
  "container_down",
  "deploy_regression",
  "resource",
  "unknown",
]);

const IsoTimestamp = z.iso.datetime();
const Confidence = z.number().min(0).max(1);

export const EvidenceSchema = z.strictObject({
  /** Referenced by Hypothesis.supportingEvidenceIds. */
  id: z.string(),
  source: z.string(),
  tool: z.string(),
  /** Redacted excerpt only; the LLM never sees raw secrets. */
  excerpt: z.string(),
  at: IsoTimestamp,
  hash: z.string(),
});

export const HypothesisSchema = z.strictObject({
  id: z.string(),
  cause: z.string(),
  supportingEvidenceIds: z.array(z.string()),
  confidence: Confidence,
});

export const SignalSchema = z.strictObject({
  check: z.string(),
  level: z.string(),
  summary: z.string(),
  at: IsoTimestamp,
});

export const IncidentStateSchema = z.strictObject({
  incidentId: z.string(),
  project: ProjectIdSchema,
  signal: SignalSchema,
  category: CategorySchema.optional(),
  evidence: z.array(EvidenceSchema),
  hypotheses: z.array(HypothesisSchema),
  verdict: z
    .strictObject({
      hypothesisId: z.string(),
      confidence: Confidence,
      dissent: z.string().optional(),
    })
    .optional(),
  /** Investigate loop counter, max 3. */
  iteration: z.number().int().min(0).max(3),
  remediation: z
    .strictObject({
      runbookId: RunbookIdSchema,
      params: z.record(z.string(), z.string()),
      risk: z.enum(["low", "medium"]),
      dryRunOutput: z.string().optional(),
    })
    .optional(),
  approval: z
    .strictObject({
      status: z.enum(["pending", "approved", "rejected", "expired"]),
      by: z.string().optional(),
      at: IsoTimestamp.optional(),
    })
    .optional(),
  execution: z.strictObject({ ok: z.boolean(), output: z.string() }).optional(),
  recovery: z.strictObject({ ok: z.boolean(), check: z.string(), at: IsoTimestamp }).optional(),
  postmortemUrl: z.string().optional(),
  /** Running total in USD; hard stop at budget (SPEC.md §8). */
  costUsd: z.number().nonnegative(),
});

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type RunbookId = z.infer<typeof RunbookIdSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type IncidentState = z.infer<typeof IncidentStateSchema>;
