import type { Redactor } from "@incidentpulse/redact";
import {
  type Category,
  type Evidence,
  type Hypothesis,
  type IncidentState,
  IncidentStateSchema,
  type ProjectId,
  type Signal,
} from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { Annotation, type BaseCheckpointSaver, END, START, StateGraph } from "@langchain/langgraph";
import { formatReport } from "./report.ts";
import type { InfraSpecialist, Synthesizer } from "./types.ts";

/**
 * Phase 1 graph (SPEC §13): intake → infra_specialist → synthesize → report.
 * Triage, fan-out, debate, approval and execution come in later phases.
 */

const IncidentAnnotation = Annotation.Root({
  incidentId: Annotation<string>(),
  project: Annotation<ProjectId>(),
  signal: Annotation<Signal>(),
  category: Annotation<Category | undefined>(),
  evidence: Annotation<Evidence[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  hypotheses: Annotation<Hypothesis[]>({ reducer: (_a, b) => b, default: () => [] }),
  iteration: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** Nodes return a delta; the reducer keeps the running total (SPEC §3.1 costUsd). */
  costUsd: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  budgetExceeded: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  reportSent: Annotation<{ sentAt: string; messageId: number } | undefined>(),
});

export type GraphState = typeof IncidentAnnotation.State;

export interface GraphDeps {
  infraSpecialist: InfraSpecialist;
  synthesizer: Synthesizer;
  notifier: Notifier;
  redact: Redactor;
  projectDomains: Record<ProjectId, string[]>;
  /** Hard stop per incident, USD (SPEC §8). */
  budgetUsd: number;
  checkpointer?: BaseCheckpointSaver;
  now?: () => Date;
}

/** The SPEC §3.1 view of the graph state, validated against the shared contract. */
export function toIncidentState(state: GraphState): IncidentState {
  const candidate = {
    incidentId: state.incidentId,
    project: state.project,
    signal: state.signal,
    ...(state.category ? { category: state.category } : {}),
    evidence: state.evidence,
    hypotheses: state.hypotheses,
    iteration: state.iteration,
    costUsd: state.costUsd,
  };
  return IncidentStateSchema.parse(candidate);
}

export function buildIncidentGraph(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  const intake = async (state: GraphState) => ({
    // Normalize the untrusted signal text: collapse whitespace, bounded length.
    signal: {
      ...state.signal,
      level: state.signal.level.trim().toLowerCase(),
      summary: state.signal.summary.replace(/\s+/g, " ").trim().slice(0, 1000),
    },
    iteration: 0,
  });

  const infraSpecialist = async (state: GraphState) => {
    const domains = deps.projectDomains[state.project];
    if (domains.length === 0) {
      throw new Error(
        `No domains configured for project "${state.project}" (see PROJECT_DOMAINS_JSON)`,
      );
    }
    const result = await deps.infraSpecialist.investigate({
      project: state.project,
      domains,
      signal: state.signal,
      evidenceOffset: state.evidence.length,
    });
    return {
      evidence: result.evidence,
      costUsd: result.costUsd,
      budgetExceeded: state.costUsd + result.costUsd >= deps.budgetUsd,
    };
  };

  const synthesize = async (state: GraphState) => {
    const result = await deps.synthesizer.synthesize({
      project: state.project,
      signal: state.signal,
      evidence: state.evidence,
    });
    return {
      category: result.category,
      hypotheses: result.hypotheses,
      costUsd: result.costUsd,
      budgetExceeded: state.costUsd + result.costUsd >= deps.budgetUsd,
    };
  };

  const report = async (state: GraphState) => {
    // Refuse to publish anything that does not satisfy the shared IncidentState contract.
    toIncidentState(state);
    const text = formatReport({
      incidentId: state.incidentId,
      project: state.project,
      evidence: state.evidence,
      hypotheses: state.hypotheses,
      costUsd: state.costUsd,
      budgetExceeded: state.budgetExceeded,
      budgetUsd: deps.budgetUsd,
    });
    const sent = await deps.notifier.send(deps.redact(text));
    return { reportSent: { sentAt: now().toISOString(), messageId: sent.messageId } };
  };

  return (
    new StateGraph(IncidentAnnotation)
      .addNode("intake", intake)
      .addNode("infra_specialist", infraSpecialist)
      .addNode("synthesize", synthesize)
      .addNode("report", report)
      .addEdge(START, "intake")
      .addEdge("intake", "infra_specialist")
      // Budget guard: once the incident budget is spent, no further LLM call is made.
      .addConditionalEdges(
        "infra_specialist",
        (s: GraphState) => (s.budgetExceeded ? "report" : "synthesize"),
        { report: "report", synthesize: "synthesize" },
      )
      .addEdge("synthesize", "report")
      .addEdge("report", END)
      .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {})
  );
}

export type IncidentGraph = ReturnType<typeof buildIncidentGraph>;
