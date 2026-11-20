import type { Category, Evidence, Hypothesis, ProjectId, Signal } from "@incidentpulse/schemas";

export interface InfraInvestigation {
  evidence: Evidence[];
  /** The agent's own short summary. For logs only; evidence is built from raw tool results. */
  summary: string;
  costUsd: number;
}

/** infra_specialist node (SPEC §3.2). Real impl: OpenAI Agents SDK agent + mcp-infra tools. */
export interface InfraSpecialist {
  investigate(input: {
    project: ProjectId;
    domains: string[];
    signal: Signal;
    /** Evidence ids continue from here (e1, e2, ...). */
    evidenceOffset: number;
  }): Promise<InfraInvestigation>;
}

export interface SynthesisResult {
  category: Category;
  hypotheses: Hypothesis[];
  costUsd: number;
}

/** synthesize node (SPEC §3.2): structured-output LLM call that ranks hypotheses. */
export interface Synthesizer {
  synthesize(input: {
    project: ProjectId;
    signal: Signal;
    evidence: Evidence[];
  }): Promise<SynthesisResult>;
}
