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
      status: "investigating",
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
  await redis.del(`${PREFIX}:web:login`);
  redis.disconnect();
}
