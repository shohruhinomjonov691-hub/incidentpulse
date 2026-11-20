import type { Category, Evidence, Hypothesis, ProjectId, Signal } from "@incidentpulse/schemas";

export const SPECIALISTS = ["infra", "code", "logs"] as const;
export type SpecialistName = (typeof SPECIALISTS)[number];

export interface TraceEvent {
  at: string;
  node: string;
  event: string;
  detail?: Record<string, string | number | boolean | null | string[]>;
}

// ------------------------------------------------------------------- specialists

export interface SpecialistResult {
  evidence: Evidence[];
  /** The agent's own short summary. For logs only; evidence is built from raw tool results. */
  summary: string;
  costUsd: number;
  toolCalls: number;
  /** Calls the MCP server refused (off-allowlist target, denied project). Counted as unsafe attempts. */
  blockedCalls: number;
  /** Tool outputs in which the injection guardrail found suspicious text. */
  injectionFlags: number;
}

/** infra / logs / code specialist (SPEC §4). Real impl: Agents SDK agent + its own MCP server. */
export interface Specialist {
  readonly name: SpecialistName;
  /** Whether this specialist has anything to work with for the project (domains, containers, CodeTrail). */
  isAvailable(project: ProjectId): boolean;
  investigate(input: {
    project: ProjectId;
    signal: Signal;
    /** Triage's preliminary category, as a hint only. */
    triageCategory: Category;
    triageReason: string;
    quickEvidence?: Evidence[];
    missing?: string[];
  }): Promise<SpecialistResult>;
}

export type Specialists = Partial<Record<SpecialistName, Specialist>>;

// ------------------------------------------------------------------------ triage

export interface TriageHandoff {
  /** Agent the triage agent handed off to, e.g. "infra_specialist". */
  to: string;
  reason: string;
}

export interface TriageDecision {
  category: Category;
  /** Specialists to run in parallel: the handoff target first, then the ones it asked for too. */
  specialists: SpecialistName[];
  reason: string;
  handoffs: TriageHandoff[];
  /** The model did not hand off (or named nothing usable), so the default specialist set was used. */
  fallback: boolean;
  /** Quick-look probe results (http_probe / tls_inspect), as evidence. */
  evidence: Evidence[];
  costUsd: number;
  blockedCalls: number;
  injectionFlags: number;
}

/** triage node (SPEC §3.2): Agents SDK Agent with handoffs to the specialists. May not conclude. */
export interface Triage {
  triage(input: {
    project: ProjectId;
    signal: Signal;
    available: SpecialistName[];
    quickEvidence?: Evidence[];
    categoryHint?: Category;
  }): Promise<TriageDecision>;
}

// -------------------------------------------------------------------- synthesize

export interface SynthesisResult {
  category: Category;
  hypotheses: Hypothesis[];
  costUsd: number;
  /** How many times the output guardrail rejected an attempt before this one was accepted. */
  guardrailRetries: number;
}

/** Thrown when the output guardrail rejects the synthesis again after the retry. */
export class SynthesisRejectedError extends Error {
  readonly problems: string[];
  readonly costUsd: number;
  constructor(problems: string[], costUsd: number) {
    super(`Synthesis rejected by the output guardrail: ${problems.join("; ")}`);
    this.name = "SynthesisRejectedError";
    this.problems = problems;
    this.costUsd = costUsd;
  }
}

/** synthesize node (SPEC §3.2): structured-output LLM call that ranks hypotheses. */
export interface Synthesizer {
  synthesize(input: {
    project: ProjectId;
    signal: Signal;
    evidence: Evidence[];
    triageCategory: Category | undefined;
  }): Promise<SynthesisResult>;
}
