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
import type { DailyBudget } from "./daily-budget.ts";
import { formatEscalation, formatReport, type OverBudget } from "./report.ts";
import type { InfraSpecialist, Synthesizer } from "./types.ts";

/**
 * Graph (SPEC §13, Phase 1 + SPEC §8 budgets):
 *
 *   intake → infra_specialist → synthesize → report
 *      │            │
 *      └────────────┴── a budget is spent ──► escalate (Telegram "needs a human")
 *
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
  /** Which budget (if any) is spent. "daily" wins over "incident". */
  overBudget: Annotation<OverBudget>({ reducer: (_a, b) => b, default: () => null }),
  /** Today's total spend (all incidents) as last seen by this incident. */
  dailySpentUsd: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  reportSent: Annotation<{ sentAt: string; messageId: number } | undefined>(),
  escalation: Annotation<
    { reason: "incident_budget" | "daily_budget"; sentAt: string; messageId: number } | undefined
  >(),
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
  /** Hard stop per UTC day across all incidents, USD (SPEC §8). */
  dailyBudgetUsd: number;
  dailyBudget: DailyBudget;
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

  const classify = (incidentCostUsd: number, dailyTotalUsd: number): OverBudget => {
    if (dailyTotalUsd >= deps.dailyBudgetUsd) return "daily";
    if (incidentCostUsd >= deps.budgetUsd) return "incident";
    return null;
  };

  const intake = async (state: GraphState) => {
    // Daily gate: when today's budget is already spent, no LLM call is made at all.
    const spent = await deps.dailyBudget.spentUsd(now());
    return {
      // Normalize the untrusted signal text: collapse whitespace, bounded length.
      signal: {
        ...state.signal,
        level: state.signal.level.trim().toLowerCase(),
        summary: state.signal.summary.replace(/\s+/g, " ").trim().slice(0, 1000),
      },
      iteration: 0,
      dailySpentUsd: spent,
      overBudget: spent >= deps.dailyBudgetUsd ? ("daily" as const) : null,
    };
  };

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
    const dailyTotal = await deps.dailyBudget.addUsd(result.costUsd, now());
    return {
      evidence: result.evidence,
      costUsd: result.costUsd,
      dailySpentUsd: dailyTotal,
      overBudget: classify(state.costUsd + result.costUsd, dailyTotal),
    };
  };

  const synthesize = async (state: GraphState) => {
    const result = await deps.synthesizer.synthesize({
      project: state.project,
      signal: state.signal,
      evidence: state.evidence,
    });
    const dailyTotal = await deps.dailyBudget.addUsd(result.costUsd, now());
    return {
      category: result.category,
      hypotheses: result.hypotheses,
      costUsd: result.costUsd,
      dailySpentUsd: dailyTotal,
      overBudget: classify(state.costUsd + result.costUsd, dailyTotal),
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
      overBudget: state.overBudget,
      budgetUsd: deps.budgetUsd,
      dailyBudgetUsd: deps.dailyBudgetUsd,
    });
    const sent = await deps.notifier.send(deps.redact(text));
    return { reportSent: { sentAt: now().toISOString(), messageId: sent.messageId } };
  };

  const escalate = async (state: GraphState) => {
    toIncidentState(state);
    const reason = state.overBudget === "daily" ? "daily_budget" : "incident_budget";
    const text = formatEscalation({
      incidentId: state.incidentId,
      project: state.project,
      reason,
      evidence: state.evidence,
      costUsd: state.costUsd,
      spentTodayUsd: state.dailySpentUsd,
      budgetUsd: deps.budgetUsd,
      dailyBudgetUsd: deps.dailyBudgetUsd,
    });
    const sent = await deps.notifier.send(deps.redact(text));
    return { escalation: { reason, sentAt: now().toISOString(), messageId: sent.messageId } };
  };

  return (
    new StateGraph(IncidentAnnotation)
      .addNode("intake", intake)
      .addNode("infra_specialist", infraSpecialist)
      .addNode("synthesize", synthesize)
      .addNode("report", report)
      .addNode("escalate", escalate)
      .addEdge(START, "intake")
      // Budget guards: once a budget is spent, no further LLM call is made.
      .addConditionalEdges(
        "intake",
        (s: GraphState) => (s.overBudget ? "escalate" : "infra_specialist"),
        { escalate: "escalate", infra_specialist: "infra_specialist" },
      )
      .addConditionalEdges(
        "infra_specialist",
        (s: GraphState) => (s.overBudget ? "escalate" : "synthesize"),
        { escalate: "escalate", synthesize: "synthesize" },
      )
      .addEdge("synthesize", "report")
      .addEdge("report", END)
      .addEdge("escalate", END)
      .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {})
  );
}

export type IncidentGraph = ReturnType<typeof buildIncidentGraph>;
