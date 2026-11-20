import type { ModelPricing } from "@incidentpulse/config";
import { describeError, type Redactor } from "@incidentpulse/redact";
import {
  type Category,
  type DebateVerdict,
  type Evidence,
  type Hypothesis,
  type IncidentState,
  IncidentStateSchema,
  PROJECT_DISPLAY_NAMES,
  type ProjectId,
  type Signal,
} from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  interrupt,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { ActionControls, ActionFlow } from "./action-flow.ts";
import { WeeklyBudgetExhausted } from "./agents/sdk.ts";
import { costOf, sumUsage } from "./cost.ts";
import { DEBATE_RESERVE_USD, DebateUnavailable, type DebateVerifier } from "./debate.ts";
import { evidenceForModel } from "./evidence.ts";
import { scrubText } from "./guardrails.ts";
import type { PrimaryEvidence } from "./primary-evidence.ts";
import type { RemediationProposer } from "./remediation-proposer.ts";
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
import type { WeeklyBudget } from "./weekly-budget.ts";

/**
 * Graph (SPEC §13 Phase 2, §8 budgets):
 *
 *   intake → triage ──Send──► investigate (one run per chosen specialist, in parallel) → join
 *      │        │                                                                        │
 *      │        └── a budget is spent ──────────────────────────────────┐                ▼
 *      └── this week's budget already spent ──────────────────────────────► escalate ◄── synthesize → report
 *                                                    (guardrail rejected the synthesis) ──┘
 */

const EVIDENCE_ORDER: Record<string, number> = { p: 0, t: 0, i: 1, l: 2, c: 3 };
function compareEvidence(a: Evidence, b: Evidence): number {
  const rank = (e: Evidence) => EVIDENCE_ORDER[e.id.charAt(0)] ?? 9;
  return rank(a) - rank(b) || a.id.localeCompare(b.id, "en", { numeric: true });
}

const sum = (a: number, b: number) => a + b;

const IncidentAnnotation = Annotation.Root({
  incidentId: Annotation<string>(),
  project: Annotation<ProjectId>(),
  signal: Annotation<Signal>(),
  primary: Annotation<PrimaryEvidence | undefined>(),
  category: Annotation<Category | undefined>(),
  /** Parallel branches append; the reducer keeps a deterministic order regardless of finish time. */
  evidence: Annotation<Evidence[]>({
    reducer: (a, b) => [...a, ...b].sort(compareEvidence),
    default: () => [],
  }),
  hypotheses: Annotation<Hypothesis[]>({ reducer: (_a, b) => b, default: () => [] }),
  verdict: Annotation<DebateVerdict | null>(),
  debateRounds: Annotation<number>({ reducer: sum, default: () => 0 }),
  remediation: Annotation<IncidentState["remediation"]>(),
  approval: Annotation<IncidentState["approval"]>(),
  approvalId: Annotation<string | undefined>(),
  actionAttempt: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  execution: Annotation<IncidentState["execution"]>(),
  recovery: Annotation<IncidentState["recovery"]>(),
  actionFailure: Annotation<"remediation" | "recovery" | null>(),
  workflowStatus: Annotation<"waiting_human" | "rejected" | "recovered" | undefined>(),
  iteration: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** Nodes return a delta; the reducer keeps the running total (SPEC §3.1 costUsd). */
  costUsd: Annotation<number>({ reducer: sum, default: () => 0 }),
  /** Which budget (if any) is spent. "weekly" wins over "incident". */
  overBudget: Annotation<OverBudget>({ reducer: (_a, b) => b, default: () => null }),
  /** This week's total spend (all incidents). max(): parallel branches may report in any order. */
  weeklySpentUsd: Annotation<number>({ reducer: (a, b) => Math.max(a, b), default: () => 0 }),
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
  /** Hard stop per calendar week across all incidents, USD (SPEC §8). */
  weeklyBudgetUsd: number;
  weeklyBudget: WeeklyBudget;
  /** Live model requests already charge the ledger. Mocks are accounted for by node. */
  requestPricing?: ModelPricing;
  debate?: { mode: "auto" | "always" | "off"; client?: DebateVerifier };
  controls?: ActionControls;
  actions?: {
    flow: ActionFlow;
    propose: RemediationProposer;
    recover(state: GraphState): Promise<{ ok: boolean; check: string }>;
  };
  checkpointer?: BaseCheckpointSaver;
  now?: () => Date;
}

interface InvestigatePayload {
  incidentId: string;
  iteration: number;
  missing?: string[];
  specialist: SpecialistName;
  project: ProjectId;
  signal: Signal;
  triageCategory: Category;
  triageReason: string;
  quickEvidence?: Evidence[];
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
    ...(state.verdict ? { verdict: state.verdict } : {}),
    ...(state.remediation ? { remediation: state.remediation } : {}),
    ...(state.approval ? { approval: state.approval } : {}),
    ...(state.execution ? { execution: state.execution } : {}),
    ...(state.recovery ? { recovery: state.recovery } : {}),
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

  const account = (usd: number) =>
    deps.requestPricing ? deps.weeklyBudget.spentUsd(now()) : deps.weeklyBudget.addUsd(usd, now());
  const whenExhausted = (error: WeeklyBudgetExhausted) => ({
    overBudget: "weekly" as const,
    weeklySpentUsd: error.spentUsd,
    costUsd:
      error.incidentStageCostUsd ??
      (deps.requestPricing && error.state
        ? costOf(sumUsage([error.state.usage]), deps.requestPricing)
        : 0),
  });

  const classify = (incidentCostUsd: number, weeklyTotalUsd: number): OverBudget => {
    if (weeklyTotalUsd >= deps.weeklyBudgetUsd) return "weekly";
    if (incidentCostUsd >= deps.budgetUsd) return "incident";
    return null;
  };

  const waitIfStopped = async (incidentId: string) => {
    while (await deps.controls?.isStopped()) {
      await deps.controls?.markPaused(incidentId);
      interrupt({ kind: "paused", incidentId });
    }
  };
  const gated =
    <S extends { incidentId: string }, R>(node: (s: S) => Promise<R>) =>
    async (state: S): Promise<R> => {
      await waitIfStopped(state.incidentId);
      return node(state);
    };

  const intake = async (state: GraphState) => {
    // Weekly gate: when this week's budget is already spent, no LLM call is made at all.
    const spent = await deps.weeklyBudget.spentUsd(now());
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
      weeklySpentUsd: spent,
      overBudget: spent >= deps.weeklyBudgetUsd ? ("weekly" as const) : null,
      injectionFlags: summary.flaggedCount + (state.primary?.injectionFlags ?? 0),
      unsafeAttempts: state.primary?.unsafeAttempts ?? 0,
      evidence: state.primary?.quickEvidence ?? [],
      trace: [
        event("intake", "signal_received", {
          project: state.project,
          injectionFlags: summary.flaggedCount,
          weeklySpentUsd: Number(spent.toFixed(6)),
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
    const d = await deps.triage
      .triage({
        project: state.project,
        signal: state.signal,
        available,
        ...(state.primary
          ? { quickEvidence: state.primary.quickEvidence, categoryHint: state.primary.category }
          : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof WeeklyBudgetExhausted) return error;
        throw error;
      });
    if (d instanceof WeeklyBudgetExhausted) return whenExhausted(d);
    const weeklyTotal = await account(d.costUsd);
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
      weeklySpentUsd: weeklyTotal,
      overBudget: classify(state.costUsd + d.costUsd, weeklyTotal),
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
          quickProbes: state.evidence.length + d.evidence.length,
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
            iteration: payload.iteration,
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
        ...(payload.quickEvidence ? { quickEvidence: payload.quickEvidence } : {}),
        ...(payload.missing ? { missing: payload.missing } : {}),
      });
      const weeklyTotal = await account(r.costUsd);
      return {
        evidence: payload.iteration
          ? r.evidence.map((e) => ({ ...e, id: `${e.id}-r${payload.iteration}` }))
          : r.evidence,
        costUsd: r.costUsd,
        weeklySpentUsd: weeklyTotal,
        unsafeAttempts: r.blockedCalls,
        injectionFlags: r.injectionFlags,
        trace: [
          event("investigate", "specialist_done", {
            specialist: payload.specialist,
            iteration: payload.iteration,
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
      if (error instanceof WeeklyBudgetExhausted) {
        const { overBudget: _overBudget, ...usage } = whenExhausted(error);
        return { ...usage, trace: [event("investigate", "weekly_budget_exhausted")] };
      }
      // One failing specialist must not sink the incident: record it and let the others finish.
      return {
        trace: [
          event("investigate", "specialist_failed", {
            specialist: payload.specialist,
            iteration: payload.iteration,
            error: describeError(error, deps.redact),
          }),
        ],
      };
    }
  };

  const join = async (state: GraphState) => {
    const chosen = state.iteration
      ? SPECIALISTS.filter((name) => deps.specialists[name]?.isAvailable(state.project)).length
      : (state.triageResult?.specialists.length ?? 0);
    const failed = state.trace.filter(
      (e) => e.event === "specialist_failed" && (e.detail?.iteration ?? 0) === state.iteration,
    ).length;
    const spent = await deps.weeklyBudget.spentUsd(now());
    if (spent < deps.weeklyBudgetUsd && chosen > 0 && failed >= chosen)
      throw new Error("Every specialist failed; nothing to synthesize");
    const depleted = state.trace.some((entry) => entry.event === "weekly_budget_exhausted");
    return {
      weeklySpentUsd: spent,
      overBudget: depleted ? ("weekly" as const) : classify(state.costUsd, spent),
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
      const weeklyTotal = await account(result.costUsd);
      return {
        category: result.category,
        hypotheses: result.hypotheses,
        verdict: null,
        costUsd: result.costUsd,
        weeklySpentUsd: weeklyTotal,
        overBudget: classify(state.costUsd + result.costUsd, weeklyTotal),
        trace: [
          event("synthesize", "synthesized", {
            category: result.category,
            hypotheses: result.hypotheses.length,
            guardrailRetries: result.guardrailRetries,
          }),
        ],
      };
    } catch (error) {
      if (error instanceof WeeklyBudgetExhausted) {
        return whenExhausted(error);
      }
      if (!(error instanceof SynthesisRejectedError)) throw error;
      const weeklyTotal = await account(error.costUsd);
      return {
        costUsd: error.costUsd,
        weeklySpentUsd: weeklyTotal,
        overBudget: classify(state.costUsd + error.costUsd, weeklyTotal),
        guardrailRejection: error.problems.join("; ").slice(0, 500),
        trace: [event("synthesize", "guardrail_rejected", { problems: error.problems })],
      };
    }
  };

  const verify = async (state: GraphState) => {
    const debate = deps.debate;
    const distinct = evidenceForModel(state.evidence);
    const sourceCount = new Set(distinct.map((e) => e.source)).size;
    if (
      !debate ||
      debate.mode === "off" ||
      state.debateRounds >= 2 ||
      (debate.mode === "auto" && (state.hypotheses[0]?.confidence ?? 0) >= 0.9 && sourceCount > 1)
    ) {
      return { trace: debate ? [event("verify", "debate_skipped")] : [] };
    }
    if (!debate.client)
      return { trace: [event("verify", "debate_unavailable", { reason: "not configured" })] };
    const at = now();
    const spent = await deps.weeklyBudget.spentUsd(at);
    if (
      spent + DEBATE_RESERVE_USD > deps.weeklyBudgetUsd ||
      state.costUsd + DEBATE_RESERVE_USD > deps.budgetUsd
    ) {
      return {
        overBudget:
          spent + DEBATE_RESERVE_USD > deps.weeklyBudgetUsd
            ? ("weekly" as const)
            : ("incident" as const),
        weeklySpentUsd: spent,
      };
    }
    await deps.weeklyBudget.addUsd(DEBATE_RESERVE_USD, at);
    let result: Awaited<ReturnType<DebateVerifier["verify"]>>;
    try {
      result = await debate.client.verify(distinct, state.hypotheses);
    } catch (error) {
      // A timeout may have incurred provider usage. Release only a known pre-model failure.
      const beforeModel = error instanceof DebateUnavailable && error.beforeModel;
      const cost = beforeModel ? 0 : DEBATE_RESERVE_USD;
      const total = beforeModel
        ? await deps.weeklyBudget.releaseUsd(DEBATE_RESERVE_USD, at)
        : spent + DEBATE_RESERVE_USD;
      return {
        debateRounds: 1,
        costUsd: cost,
        weeklySpentUsd: total,
        overBudget: classify(state.costUsd + cost, total),
        trace: [
          event("verify", "debate_unavailable", { reason: describeError(error, deps.redact) }),
        ],
      };
    }
    const received = Math.round(result.costUsd * 1_000_000) / 1_000_000;
    const weeklyTotal =
      received > DEBATE_RESERVE_USD
        ? await deps.weeklyBudget.addUsd(received - DEBATE_RESERVE_USD, at)
        : await deps.weeklyBudget.releaseUsd(DEBATE_RESERVE_USD - received, at);
    const verdict = result.verdict;
    const grounded = state.hypotheses.some((h) => h.id === verdict.hypothesisId);
    return {
      verdict: grounded
        ? {
            ...verdict,
            dissent: deps.redact(scrubText(verdict.dissent).text),
            missing: verdict.missing.map((item) => deps.redact(scrubText(item).text)),
          }
        : null,
      debateRounds: 1,
      costUsd: result.costUsd,
      weeklySpentUsd: weeklyTotal,
      overBudget: classify(state.costUsd + result.costUsd, weeklyTotal),
      trace: [
        event("verify", grounded ? "debate_verdict" : "debate_unavailable", {
          confidence: verdict.confidence,
          missing: verdict.missing.length,
          round: state.debateRounds + 1,
        }),
      ],
    };
  };

  const reinvestigate = async (state: GraphState) => ({
    iteration: state.iteration + 1,
    trace: [event("reinvestigate", "collect_missing", { missing: state.verdict?.missing ?? [] })],
  });
  const fanout = (state: GraphState, repeat = false) => {
    if (!state.triageResult) return [];
    const chosen = repeat
      ? SPECIALISTS.filter((name) => deps.specialists[name]?.isAvailable(state.project))
      : state.triageResult.specialists;
    return chosen.map(
      (specialist) =>
        new Send("investigate", {
          incidentId: state.incidentId,
          iteration: state.iteration,
          specialist,
          project: state.project,
          signal: state.signal,
          triageCategory: state.triageResult?.category ?? "unknown",
          triageReason: state.triageResult?.reason ?? "",
          ...(repeat
            ? { missing: state.verdict?.missing ?? [] }
            : { quickEvidence: state.evidence }),
        } satisfies InvestigatePayload),
    );
  };

  const propose = async (state: GraphState) => {
    const actions = deps.actions;
    if (!actions) return {};
    const spent = await deps.weeklyBudget.spentUsd(now());
    const blocked = classify(state.costUsd, spent);
    if (blocked) return { overBudget: blocked, weeklySpentUsd: spent };
    const existing = await actions.flow.approvals.find(state.incidentId, state.actionAttempt);
    let row = existing;
    let proposalCost = 0;
    let total = spent;
    if (!row) {
      try {
        const proposal = await actions.propose(state);
        proposalCost = proposal.costUsd;
        total = await account(proposalCost);
        const overBudget = classify(state.costUsd + proposalCost, total);
        if (overBudget) return { costUsd: proposalCost, weeklySpentUsd: total, overBudget };
        if (!proposal.book)
          return {
            remediation: undefined,
            costUsd: proposalCost,
            weeklySpentUsd: total,
            ...(state.actionAttempt > 0 || proposal.rejected
              ? { actionFailure: "remediation" as const }
              : {}),
            trace: [event("propose", proposal.rejected ? "runbook_rejected" : "no_runbook")],
          };
        const result = await actions.flow.dryRun(proposal.book);
        if (!result.ok)
          return {
            actionFailure: "remediation" as const,
            costUsd: proposalCost,
            weeklySpentUsd: total,
            trace: [event("propose", "dry_run_failed", { output: result.output.slice(0, 350) })],
          };
        row = await actions.flow.approvals.prepare({
          incidentId: state.incidentId,
          project: state.project,
          check: state.signal.check,
          attempt: state.actionAttempt,
          runbookId: proposal.book.runbookId,
          params: proposal.book.params,
          risk: proposal.book.risk,
          dryRunOutput: result.output,
          details: deps
            .redact(state.evidence.map((e) => `[${e.id}] ${e.excerpt}`).join("\n"))
            .slice(0, 2900),
        });
      } catch (error) {
        if (error instanceof WeeklyBudgetExhausted) return whenExhausted(error);
        throw error;
      }
    }
    return {
      approvalId: row.id,
      remediation: {
        runbookId: row.runbookId,
        params: row.params,
        risk: row.risk,
        dryRunOutput: row.dryRunOutput,
      },
      approval: { status: "pending" as const },
      costUsd: proposalCost,
      weeklySpentUsd: total,
      trace: [
        event("propose", "dry_run_ok", { runbook: row.runbookId, attempt: state.actionAttempt }),
      ],
    };
  };

  const requestApproval = async (state: GraphState) => {
    const row = state.approvalId
      ? await deps.actions?.flow.approvals.get(state.approvalId)
      : undefined;
    if (!row || !deps.actions) throw new Error("Missing approval record");
    await deps.actions.flow.notify(row, state, deps.budgetUsd, deps.weeklyBudgetUsd);
    return { trace: [event("request_approval", "approval_requested")] };
  };

  const awaitApproval = async (state: GraphState) => {
    // The approval interrupt is always first, so the resume cursor cannot be shifted by a new /stop.
    await deps.controls?.isStopped();
    interrupt({ kind: "approval", approvalId: state.approvalId });
    await waitIfStopped(state.incidentId);
    const row = state.approvalId
      ? await deps.actions?.flow.approvals.get(state.approvalId)
      : undefined;
    if (!row || row.status === "pending") throw new Error("No persisted approval decision");
    return {
      approval: {
        status: row.status,
        ...(row.decidedBy ? { by: row.decidedBy } : {}),
        ...(row.decidedAt ? { at: row.decidedAt.toISOString() } : {}),
      },
      trace: [event("await_approval", row.status, { by: row.decidedBy ?? "system" })],
    };
  };

  const execute = async (state: GraphState) => {
    const row = state.approvalId
      ? await deps.actions?.flow.approvals.get(state.approvalId)
      : undefined;
    if (row?.status !== "approved" || !deps.actions) throw new Error("No approved runbook");
    const execution = await deps.actions.flow.execute(row);
    return {
      execution,
      trace: [event("execute", "runbook_finished", { ok: execution.ok, runbook: row.runbookId })],
    };
  };

  const verifyRecovery = async (state: GraphState) => {
    if (!deps.actions) return {};
    const result = await deps.actions.recover(state);
    const recovery = { ...result, at: now().toISOString() };
    const retry = !result.ok && state.actionAttempt < 2;
    return {
      recovery,
      actionAttempt: retry ? state.actionAttempt + 1 : state.actionAttempt,
      ...(retry ? { remediation: undefined, approval: undefined, approvalId: undefined } : {}),
      ...(!result.ok && !retry ? { actionFailure: "recovery" as const } : {}),
      trace: [
        event("verify_recovery", result.ok ? "recovered" : "still_down", { check: result.check }),
      ],
    };
  };

  const close = async (state: GraphState) => {
    const name = PROJECT_DISPLAY_NAMES[state.project];
    if (state.recovery?.ok) {
      await deps.actions?.flow.approvals.closeForRecovery(state.project, state.signal.check);
      await deps.notifier.send(
        `🟢 ${name} · #${state.incidentId} · Tiklandi (${state.recovery.check})`,
      );
      return { workflowStatus: "recovered" as const };
    }
    const expired = state.approval?.status === "expired";
    await deps.notifier.send(
      expired
        ? `🟠 ${name} · #${state.incidentId} · tasdiqlash muddati tugadi, inson ko‘rigi kutilmoqda.`
        : `⚪ ${name} · #${state.incidentId} · tuzatish taklifi rad etildi.`,
    );
    return { workflowStatus: expired ? ("waiting_human" as const) : ("rejected" as const) };
  };

  const report = async (state: GraphState) => {
    // Refuse to publish anything that does not satisfy the shared IncidentState contract.
    toIncidentState(state);
    const text = formatReport({
      incidentId: state.incidentId,
      project: state.project,
      evidence: state.evidence,
      hypotheses: state.hypotheses,
      verdict: state.verdict ?? undefined,
      costUsd: state.costUsd,
      overBudget: state.overBudget,
      budgetUsd: deps.budgetUsd,
      weeklyBudgetUsd: deps.weeklyBudgetUsd,
    });
    const sent = await deps.notifier.send(deps.redact(text));
    return { reportSent: { sentAt: now().toISOString(), messageId: sent.messageId } };
  };

  const escalate = async (state: GraphState) => {
    toIncidentState(state);
    const reason: EscalationReason =
      state.overBudget === "weekly"
        ? "weekly_budget"
        : state.guardrailRejection
          ? "guardrail"
          : (state.actionFailure ?? "incident_budget");
    const text = formatEscalation({
      incidentId: state.incidentId,
      project: state.project,
      reason,
      evidence: state.evidence,
      costUsd: state.costUsd,
      spentThisWeekUsd: state.weeklySpentUsd,
      budgetUsd: deps.budgetUsd,
      weeklyBudgetUsd: deps.weeklyBudgetUsd,
    });
    const sent = await deps.notifier.send(deps.redact(text));
    return {
      escalation: { reason, sentAt: now().toISOString(), messageId: sent.messageId },
      trace: [event("escalate", "escalated", { reason })],
    };
  };

  return new StateGraph(IncidentAnnotation)
    .addNode("intake", gated(intake))
    .addNode("triage", gated(triage))
    .addNode(
      "investigate",
      gated(investigate) as unknown as (s: GraphState) => Promise<Partial<GraphState>>,
    )
    .addNode("join", gated(join))
    .addNode("synthesize", gated(synthesize))
    .addNode("verify", gated(verify))
    .addNode("reinvestigate", gated(reinvestigate))
    .addNode("propose", gated(propose))
    .addNode("request_approval", gated(requestApproval))
    .addNode("await_approval", awaitApproval)
    .addNode("execute", gated(execute))
    .addNode("verify_recovery", gated(verifyRecovery))
    .addNode("close", gated(close))
    .addNode("report", gated(report))
    .addNode("escalate", gated(escalate))
    .addEdge(START, "intake")
    .addConditionalEdges("intake", (s) => (s.overBudget ? "escalate" : "triage"), [
      "escalate",
      "triage",
    ])
    .addConditionalEdges(
      "triage",
      (s) => (s.overBudget || !s.triageResult ? "escalate" : fanout(s)),
      ["investigate", "escalate"],
    )
    .addEdge("investigate", "join")
    .addConditionalEdges("join", (s) => (s.overBudget ? "escalate" : "synthesize"), [
      "escalate",
      "synthesize",
    ])
    .addConditionalEdges(
      "synthesize",
      (s) => {
        if (s.guardrailRejection || s.overBudget === "weekly") return "escalate";
        if (s.overBudget) return deps.actions ? "escalate" : "report";
        return deps.debate ? "verify" : deps.actions ? "propose" : "report";
      },
      ["escalate", "verify", "propose", "report"],
    )
    .addConditionalEdges(
      "verify",
      (s) => {
        if (s.overBudget) return "escalate";
        if (s.verdict && s.verdict.confidence < 0.7 && s.iteration < 3) return "reinvestigate";
        return deps.actions ? "propose" : "report";
      },
      ["escalate", "reinvestigate", "propose", "report"],
    )
    .addConditionalEdges("reinvestigate", (s) => fanout(s, true), ["investigate"])
    .addConditionalEdges(
      "propose",
      (s) =>
        s.overBudget || s.actionFailure
          ? "escalate"
          : s.remediation
            ? "request_approval"
            : "report",
      ["escalate", "request_approval", "report"],
    )
    .addEdge("request_approval", "await_approval")
    .addConditionalEdges(
      "await_approval",
      (s) => (s.approval?.status === "approved" ? "execute" : "close"),
      ["execute", "close"],
    )
    .addEdge("execute", "verify_recovery")
    .addConditionalEdges(
      "verify_recovery",
      (s) => (s.recovery?.ok ? "close" : s.actionFailure ? "escalate" : "propose"),
      ["close", "escalate", "propose"],
    )
    .addEdge("close", END)
    .addEdge("report", END)
    .addEdge("escalate", END)
    .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {});
}

export type IncidentGraph = ReturnType<typeof buildIncidentGraph>;
