import { z } from "zod";
import { EvidenceSchema, HypothesisSchema } from "./incident-state.ts";

export const DebateRequestSchema = z.strictObject({
  evidence: z.array(EvidenceSchema).max(12),
  hypotheses: z.array(HypothesisSchema).min(1).max(3),
  rounds: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const DebateVerdictSchema = z.strictObject({
  hypothesisId: z.string().min(1).max(32),
  confidence: z.number().min(0).max(1),
  dissent: z.string().max(500),
  missing: z.array(z.string().min(1).max(200)).max(4),
});
export type DebateVerdict = z.infer<typeof DebateVerdictSchema>;
