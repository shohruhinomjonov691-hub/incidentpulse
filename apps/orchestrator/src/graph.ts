import { describeError, type Redactor } from "@incidentpulse/redact";
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
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { DailyBudget } from "./daily-budget.ts";
import { scrubText } from "./guardrails.ts";
import {
  type EscalationReason,
  formatEscalation,
  formatReport,
  type OverBudget,
} from "./report.ts";
import {
  SPECIALISTS,
  type SpecialistName,
  type Specialists,
  SynthesisRejectedError,
  type Synthesizer,
  type TraceEvent,
  type Triage,
} from "./types.ts";

/**
 * Graph (SPEC §13 Phase 2, §8 budgets):
 *
 *   intake → triage ──Send──► investigate (one run per chosen specialist, in parallel) → join
 *      │        │                                                                        │
 *      │        └── a budget is spent ──────────────────────────────────┐                ▼
 *      └── today's budget already spent ──────────────────────────────► escalate ◄── synthesize → report
 *                                                    (guardrail rejected the synthesis) ──┘
 */

const EVIDENCE_ORDER: Record<string, number> = { t: 0, i: 1, l: 2, c: 3 };
function compareEvidence(a: Evidence, b: Evidence): number {
  const rank = (e: Evidence) => EVIDENCE_ORDER[e.id.charAt(0)] ?? 9;
  return rank(a) - rank(b) || a.id.localeCompare(b.id, "en", { numeric: true });
}

const sum = (a: number, b: number) => a + b;

const IncidentAnnotation = Annotation.Root({
  incidentId: Annotation<string>(),
  project: Annotation<ProjectId>(),
  signal: Annotation<Signal>(),
  category: Annotation<Category | undefined>(),
  /** Parallel branches append; the reducer keeps a deterministic order regardless of finish time. */
  evidence: Annotation<Evidence[]>({
    reducer: (a, b) => [...a, ...b].sort(compareEvidence),
    default: () => [],
  }),
  hypotheses: Annotation<Hypothesis[]>({ reducer: (_a, b) => b, default: () => [] }),
  iteration: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** Nodes return a delta; the reducer keeps the running total (SPEC §3.1 costUsd). */
  costUsd: Annotation<number>({ reducer: sum, default: () => 0 }),
  /** Which budget (if any) is spent. "daily" wins over "incident". */
  overBudget: Annotation<OverBudget>({ reducer: (_a, b) => b, default: () => null }),
  /** Today's total spend (all incidents). max(): parallel branches may report in any order. */
  dailySpentUsd: Annotation<number>({ reducer: (a, b) => Math.max(a, b), default: () => 0 }),
  triageResult: Annotation<
    | { category: Category; specialists: SpecialistName[]; reason: string; fallback: boolean }
    | undefined
  >(),
  /** Append-only audit trail: handoffs, specialist runs, guardrail events. */
  trace: Annotation<TraceEvent[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  /** Tool calls the MCP servers refused (off-allowlist target etc.). SPEC §9: must stay 0 in evals. */
  unsafeAttempts: Annotation<number>({ reducer: sum, default: () => 0 }),
  injectionFlags: Annotation<number>({ reducer: sum, default: () => 0 }),
  guardrailRejection: Annotation<string | undefined>(),
  reportSent: Annotation<{ sentAt: string; messageId: number } | undefined>(),
  escalation: Annotation<
    { reason: EscalationReason; sentAt: string; messageId: number } | undefined
  >(),
});

export type GraphState = typeof IncidentAnnotation.State;

export interface GraphDeps {
  triage: Triage;
  /** The specialists that exist; each decides per project whether it is available. */
  specialists: Specialists;
  synthesizer: Synthesizer;
  notifier: Notifier;
  redact: Redactor;
  /** Hard stop per incident, USD (SPEC §8). */
  budgetUsd: number;
  /** Hard stop per calendar day across all incidents, USD (SPEC §8). */
  dailyBudgetUsd: number;
  dailyBudget: DailyBudget;
  checkpointer?: BaseCheckpointSaver;
  now?: () => Date;
}

interface InvestigatePayload {
  specialist: SpecialistName;
  project: ProjectId;
  signal: Signal;
  triageCategory: Category;
  triageReason: string;
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
  const event = (node: string, name: string, detail?: TraceEvent["detail"]): TraceEvent => ({
    at: now().toISOString(),
    node,
    event: name,
    ...(detail ? { detail } : {}),
  });

  const classify = (incidentCostUsd: number, dailyTotalUsd: number): OverBudget => {
    if (dailyTotalUsd >= deps.dailyBudgetUsd) return "daily";
    if (incidentCostUsd >= deps.budgetUsd) return "incident";
    return null;
  };

  const intake = async (state: GraphState) => {
    // Daily gate: when today's budget is already spent, no LLM call is made at all.
    const spent = await deps.dailyBudget.spentUsd(now());
    // The monitor text is outside data: normalize it and strip injection-looking lines.
    // Scrub line by line first (so one hostile line does not erase the rest), then flatten.
    const scrubbed = scrubText(state.signal.summary.slice(0, 2000));
    const summary = { ...scrubbed, text: scrubbed.text.replace(/\s+/g, " ").trim().slice(0, 1000) };
    return {
      signal: {
        ...state.signal,
        level: state.signal.level.trim().toLowerCase(),
        summary: summary.text,
      },
      iteration: 0,
      dailySpentUsd: spent,
      overBudget: spent >= deps.dailyBudgetUsd ? ("daily" as const) : null,
      injectionFlags: summary.flaggedCount,
      trace: [
        event("intake", "signal_received", {
          project: state.project,
          injectionFlags: summary.flaggedCount,
          dailySpentUsd: Number(spent.toFixed(6)),
        }),
      ],
    };
  };

  const triage = async (state: GraphState) => {
    const available = SPECIALISTS.filter((n) => deps.specialists[n]?.isAvailable(state.project));
    if (available.length === 0) {
      throw new Error(
        `No specialists available for project "${state.project}" (set PROJECT_DOMAINS_JSON, PROJECT_CONTAINERS_JSON or the CodeTrail/GitHub settings)`,
      );
    }
    const d = await deps.triage.triage({ project: state.project, signal: state.signal, available });
    const dailyTotal = await deps.dailyBudget.addUsd(d.costUsd, now());
    return {
      category: d.category,
      triageResult: {
        category: d.category,
        specialists: d.specialists,
        reason: d.reason,
        fallback: d.fallback,
      },
      evidence: d.evidence,
      costUsd: d.costUsd,
      dailySpentUsd: dailyTotal,
      overBudget: classify(state.costUsd + d.costUsd, dailyTotal),
      unsafeAttempts: d.blockedCalls,
      injectionFlags: d.injectionFlags,
      trace: [
        ...d.handoffs.map((h) =>
          event("triage", "handoff", {
            from: "triage",
            to: h.to,
            category: d.category,
            reason: h.reason,
            alsoNeeded: d.specialists.slice(1).map((s) => `${s}_specialist`),
          }),
        ),
        ...(d.fallback
          ? [event("triage", "handoff_fallback", { specialists: d.specialists })]
          : []),
        event("triage", "decision", {
          category: d.category,
          specialists: d.specialists,
          quickProbes: d.evidence.length,
          costUsd: Number(d.costUsd.toFixed(6)),
        }),
      ],
    };
  };

  /** Runs once per chosen specialist (LangGraph `Send`); the runs execute in parallel. */
  const investigate = async (payload: InvestigatePayload) => {
    const specialist = deps.specialists[payload.specialist];
    const startedAt = now().toISOString();
    if (!specialist) {
      return {
        trace: [
          event("investigate", "specialist_failed", {
            specialist: payload.specialist,
            error: "not configured",
          }),
        ],
      };
    }
    try {
      const r = await specialist.investigate({
        project: payload.project,
        signal: payload.signal,
        triageCategory: payload.triageCategory,
        triageReason: payload.triageReason,
      });
      const dailyTotal = await deps.dailyBudget.addUsd(r.costUsd, now());
      return {
        evidence: r.evidence,
        costUsd: r.costUsd,
        dailySpentUsd: dailyTotal,
        unsafeAttempts: r.blockedCalls,
        injectionFlags: r.injectionFlags,
        trace: [
          event("investigate", "specialist_done", {
            specialist: payload.specialist,
            startedAt,
            toolCalls: r.toolCalls,
            evidence: r.evidence.length,
            blockedCalls: r.blockedCalls,
            injectionFlags: r.injectionFlags,
            costUsd: Number(r.costUsd.toFixed(6)),
          }),
        ],
      };
    } catch (error) {
      // One failing specialist must not sink the incident: record it and let the others finish.
      return {
        trace: [
          event("investigate", "specialist_failed", {
            specialist: payload.specialist,
            error: describeError(error, deps.redact),
          }),
        ],
      };
    }
  };

  const join = async (state: GraphState) => {
    const chosen = state.triageResult?.specialists.length ?? 0;
    const failed = state.trace.filter((e) => e.event === "specialist_failed").length;
    if (chosen > 0 && failed >= chosen)
      throw new Error("Every specialist failed; nothing to synthesize");
    const spent = await deps.dailyBudget.spentUsd(now());
    return {
      dailySpentUsd: spent,
      overBudget: classify(state.costUsd, spent),
      trace: [
        event("join", "evidence_merged", {
          evidence: state.evidence.length,
          failedSpecialists: failed,
        }),
      ],
    };
  };

  const synthesize = async (state: GraphState) => {
    try {
      const result = await deps.synthesizer.synthesize({
        project: state.project,
        signal: state.signal,
        evidence: state.evidence,
        triageCategory: state.triageResult?.category,
      });
      const dailyTotal = await deps.dailyBudget.addUsd(result.costUsd, now());
      return {
        category: result.category,
        hypotheses: result.hypotheses,
        costUsd: result.costUsd,
        dailySpentUsd: dailyTotal,
        overBudget: classify(state.costUsd + result.costUsd, dailyTotal),
        trace: [
          event("synthesize", "synthesized", {
            category: result.category,
            hypotheses: result.hypotheses.length,
            guardrailRetries: result.guardrailRetries,
          }),
        ],
      };
    } catch (error) {
      if (!(error instanceof SynthesisRejectedError)) throw error;
      const dailyTotal = await deps.dailyBudget.addUsd(error.costUsd, now());
      return {
        costUsd: error.costUsd,
        dailySpentUsd: dailyTotal,
        guardrailRejection: error.problems.join("; ").slice(0, 500),
        trace: [event("synthesize", "guardrail_rejected", { problems: error.problems })],
      };
    }
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
    const reason: EscalationReason = state.guardrailRejection
      ? "guardrail"
      : state.overBudget === "daily"
        ? "daily_budget"
        : "incident_budget";
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
    return {
      escalation: { reason, sentAt: now().toISOString(), messageId: sent.messageId },
      trace: [event("escalate", "escalated", { reason })],
    };
  };

  return (
    new StateGraph(IncidentAnnotation)
      .addNode("intake", intake)
      .addNode("triage", triage)
      // `investigate` receives the Send payload, not the graph state.
      .addNode(
        "investigate",
        investigate as unknown as (s: GraphState) => Promise<Partial<GraphState>>,
      )
      .addNode("join", join)
      .addNode("synthesize", synthesize)
      .addNode("report", report)
      .addNode("escalate", escalate)
      .addEdge(START, "intake")
      // Budget guards: once a budget is spent, no further LLM call is made.
      .addConditionalEdges("intake", (s: GraphState) => (s.overBudget ? "escalate" : "triage"), {
        escalate: "escalate",
        triage: "triage",
      })
      // Fan-out: one parallel `investigate` run per specialist the triage agent chose.
      .addConditionalEdges(
        "triage",
        (s: GraphState) =>
          s.overBudget || !s.triageResult
            ? "escalate"
            : s.triageResult.specialists.map(
                (specialist) =>
                  new Send("investigate", {
                    specialist,
                    project: s.project,
                    signal: s.signal,
                    triageCategory: s.triageResult?.category ?? "unknown",
                    triageReason: s.triageResult?.reason ?? "",
                  } satisfies InvestigatePayload),
              ),
        ["investigate", "escalate"],
      )
      .addEdge("investigate", "join")
      .addConditionalEdges("join", (s: GraphState) => (s.overBudget ? "escalate" : "synthesize"), {
        escalate: "escalate",
        synthesize: "synthesize",
      })
      .addConditionalEdges(
        "synthesize",
        (s: GraphState) => (s.guardrailRejection ? "escalate" : "report"),
        { escalate: "escalate", report: "report" },
      )
      .addEdge("report", END)
      .addEdge("escalate", END)
      .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {})
  );
}

export type IncidentGraph = ReturnType<typeof buildIncidentGraph>;
