// Prints what was investigated and reported for one incident, straight from the Postgres checkpoint.
// Usage: pnpm --filter @incidentpulse/orchestrator show <incidentId>
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { GraphState } from "../src/graph.ts";
import { formatReport } from "../src/report.ts";

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
  const s = tuple.checkpoint.channel_values as unknown as GraphState;
  console.log(
    `category=${s.category} costUsd=${s.costUsd} reportSent=${JSON.stringify(s.reportSent)}`,
  );
  console.log("--- evidence");
  for (const e of s.evidence) console.log(`[${e.id}] ${e.excerpt}`);
  console.log("--- hypotheses");
  for (const h of s.hypotheses)
    console.log(`${h.id} (${h.confidence}) [${h.supportingEvidenceIds}] ${h.cause}`);
  console.log("--- telegram message (as sent)");
  console.log(
    formatReport({
      incidentId: s.incidentId,
      project: s.project,
      evidence: s.evidence,
      hypotheses: s.hypotheses,
      costUsd: s.costUsd,
      budgetExceeded: s.budgetExceeded,
      budgetUsd: Number(process.env.INCIDENT_BUDGET_USD ?? 0.5),
    }),
  );
} finally {
  await saver.end();
}
