// Prints what was investigated and reported for one incident, straight from the Postgres checkpoint.
// Usage: pnpm --filter @incidentpulse/orchestrator show <incidentId>
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { GraphState } from "../src/graph.ts";
import { formatEscalation, formatReport } from "../src/report.ts";

const incidentId = process.argv[2];
if (!incidentId) {
  console.error("usage: show <incidentId>");
  process.exit(2);
}

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse";
const saver = PostgresSaver.fromConnString(databaseUrl);
try {
  const tuple = await saver.getTuple({ configurable: { thread_id: incidentId } });
  if (!tuple) {
    console.error(`no checkpoint for ${incidentId}`);
    process.exit(1);
  }
  // Channels that were never written (e.g. evidence on a budget escalation) are absent here.
  const raw = tuple.checkpoint.channel_values as unknown as Partial<GraphState>;
  const s = {
    ...raw,
    evidence: raw.evidence ?? [],
    hypotheses: raw.hypotheses ?? [],
    costUsd: raw.costUsd ?? 0,
    weeklySpentUsd: raw.weeklySpentUsd ?? 0,
    overBudget: raw.overBudget ?? null,
    trace: raw.trace ?? [],
    unsafeAttempts: raw.unsafeAttempts ?? 0,
    injectionFlags: raw.injectionFlags ?? 0,
  } as GraphState;
  console.log(
    `category=${s.category} costUsd=${s.costUsd} reportSent=${JSON.stringify(s.reportSent)}`,
  );
  console.log(
    `unsafeAttempts=${s.unsafeAttempts} injectionFlags=${s.injectionFlags} triage=${JSON.stringify(s.triageResult ?? null)}`,
  );
  console.log("--- trace");
  for (const e of s.trace) {
    console.log(
      `${e.at.slice(11, 23)} ${e.node}.${e.event} ${e.detail ? JSON.stringify(e.detail) : ""}`,
    );
  }
  console.log("--- evidence");
  for (const e of s.evidence) console.log(`[${e.id}] ${e.excerpt}`);
  console.log("--- hypotheses");
  for (const h of s.hypotheses)
    console.log(`${h.id} (${h.confidence}) [${h.supportingEvidenceIds}] ${h.cause}`);
  console.log("--- telegram message (as sent)");
  const budgetUsd = Number(process.env.INCIDENT_BUDGET_USD ?? 0.5);
  const weeklyBudgetUsd = Number(process.env.WEEKLY_BUDGET_USD ?? 0.5);
  console.log(
    s.escalation
      ? formatEscalation({
          incidentId: s.incidentId,
          project: s.project,
          reason: s.escalation.reason,
          evidence: s.evidence,
          costUsd: s.costUsd,
          spentThisWeekUsd: s.weeklySpentUsd,
          budgetUsd,
          weeklyBudgetUsd,
        })
      : formatReport({
          incidentId: s.incidentId,
          project: s.project,
          evidence: s.evidence,
          hypotheses: s.hypotheses,
          costUsd: s.costUsd,
          overBudget: s.overBudget,
          budgetUsd,
          weeklyBudgetUsd,
        }),
  );
} finally {
  await saver.end();
}
