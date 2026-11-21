import {
  type DebateVerdict,
  DebateVerdictSchema,
  type Evidence,
  type Hypothesis,
} from "@incidentpulse/schemas";
import { z } from "zod";
import { evidenceForModel } from "./evidence.ts";

const Transcript = z
  .array(
    z.object({ role: z.enum(["Investigator", "Skeptic", "Judge"]), text: z.string().max(1500) }),
  )
  .max(6);

export const DEBATE_RESERVE_USD = 0.016;

export class DebateUnavailable extends Error {
  constructor(message: string, beforeModel: boolean) {
    super(message);
    this.beforeModel = beforeModel;
  }
  readonly beforeModel: boolean;
}

export interface DebateVerifier {
  verify(
    evidence: Evidence[],
    hypotheses: Hypothesis[],
  ): Promise<{ verdict: DebateVerdict; costUsd: number; transcript?: z.infer<typeof Transcript> }>;
}

export function createDebateVerifier(
  url: string,
  secret: string,
  timeoutMs: number,
): DebateVerifier {
  return {
    async verify(evidence, hypotheses) {
      const cited = new Set(hypotheses.flatMap((h) => h.supportingEvidenceIds));
      const compact = evidenceForModel(evidence)
        .sort((a, b) => Number(cited.has(b.id)) - Number(cited.has(a.id)))
        .slice(0, 12)
        .map((e) => ({ ...e, excerpt: e.excerpt.slice(0, 450) }));
      const response = await fetch(new URL("/verify", url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-debate-transcript": "1",
        },
        body: JSON.stringify({ evidence: compact, hypotheses, rounds: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((error: unknown) => {
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        throw new DebateUnavailable(
          "Debate service request failed",
          cause === "ECONNREFUSED" || cause === "ENOTFOUND" || cause === "EAI_AGAIN",
        );
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DebateUnavailable(
          `Debate service returned HTTP ${response.status}`,
          [401, 404, 413, 422, 503].includes(response.status),
        );
      }
      const rawCost = response.headers.get("x-debate-cost-usd");
      const costUsd = Number(rawCost);
      if (rawCost === null || !/^\d+(?:\.\d+)?$/.test(rawCost) || !Number.isFinite(costUsd))
        throw new Error("Invalid debate usage");
      const body = await response.json();
      if (body && typeof body === "object" && "verdict" in body && "transcript" in body) {
        return {
          verdict: DebateVerdictSchema.parse(body.verdict),
          costUsd,
          transcript: Transcript.parse(body.transcript),
        };
      }
      return { verdict: DebateVerdictSchema.parse(body), costUsd };
    },
  };
}
