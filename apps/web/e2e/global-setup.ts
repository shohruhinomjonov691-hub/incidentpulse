import { createApprovalStore } from "@incidentpulse/mcp-actions/approvals";
import { localPlan } from "@incidentpulse/mcp-actions/plan";
import { createJournal } from "@incidentpulse/orchestrator/journal";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { PREFIX, SCHEMA } from "../playwright.config.ts";

export const INCIDENT = "smoke-incident-1";

export default async function globalSetup() {
  const url = process.env.IT_DATABASE_URL;
  const redisUrl = process.env.IT_REDIS_URL;
  if (!url || !redisUrl) return;
  const admin = new Pool({ connectionString: url });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${SCHEMA}`);
  const pool = new Pool({ connectionString: scoped.href });
  const journal = createJournal(pool);
  await journal.setup();
  const approvals = createApprovalStore(pool, "smoke-execution-key-for-tests-only");
  await approvals.setup();
  const book = {
    runbookId: "nginx_site_proxy" as const,
    params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
    run: [],
    dryRun: [],
  };
  const plan = localPlan("kervan", book);
  const approval = await approvals.prepare({
    incidentId: INCIDENT,
    project: "kervan",
    check: "https",
    attempt: 0,
    runbookId: book.runbookId,
    params: book.params,
    risk: "medium",
    details: "",
    dryRunOutput: "Static checks passed",
    planDigest: plan.planDigest,
    policyDigest: plan.policyDigest,
    planSummary: plan.summary,
  });
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 21, 9, 0, seconds)).toISOString();
  await journal.append({
    id: INCIDENT,
    project: "kervan",
    events: [
      { type: "node_start", at: at(0), data: { node: "intake" } },
      { type: "tool_call", at: at(2), data: { node: "intake", tool: "tls_inspect" } },
      { type: "node_end", at: at(3), data: { node: "intake" } },
    ],
    snapshot: {
      status: "awaiting_approval",
      approvalId: approval.id,
      state: {
        incidentId: INCIDENT,
        project: "kervan",
        signal: { check: "https", level: "down", summary: "HTTPS check failed", at: at(0) },
        category: "tls",
        evidence: [
          {
            id: "E1",
            source: "mcp-infra",
            tool: "tls_inspect",
            excerpt: "certificate expired",
            at: at(2),
            hash: "h1",
          },
        ],
        hypotheses: [],
        iteration: 0,
        costUsd: 0.0123,
      },
    },
  });
  await pool.end();
  const redis = new Redis(redisUrl);
  const stale = await redis.keys(`${PREFIX}:web:login*`);
  if (stale.length) await redis.del(...stale);
  redis.disconnect();
}
