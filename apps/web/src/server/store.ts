import {
  createApprovalCallbacks,
  createApprovalDecisions,
} from "@incidentpulse/mcp-actions/approvals";
import { createRedisWeeklyBudget, reserveWeekly } from "@incidentpulse/orchestrator/budget";
import { createJournal } from "@incidentpulse/orchestrator/journal";
import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { Redis } from "ioredis";
import { Pool } from "pg";

let database: Pool | undefined;
let connection: Redis | undefined;
const prefix = process.env.WEB_RUNTIME_PREFIX;
const budgetKey = prefix ? `${prefix}:budget:weekly` : undefined;
const limit = Math.min(0.5, Number(process.env.WEEKLY_BUDGET_USD ?? 0.5));

export const redact = createRedactor({ secrets: collectSecrets(process.env) });

export function redis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  connection ??= new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  return connection;
}

function pool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  database ??= new Pool({
    connectionString: url,
    max: 8,
    query_timeout: 3500,
    connectionTimeoutMillis: 2000,
  });
  return database;
}

export const journal = () => createJournal(pool());
/**
 * What the web may do with approvals: read a row and record the human decision. It holds only
 * CALLBACK_HMAC_SECRET (button signatures). APPROVAL_HMAC_SECRET, which signs execution tokens, is never
 * given to this process, and its database role can update the decision columns and nothing else.
 */
export function approvals() {
  const secret = process.env.CALLBACK_HMAC_SECRET;
  return secret && secret.length >= 32
    ? { store: createApprovalDecisions(pool()), callbacks: createApprovalCallbacks(secret) }
    : undefined;
}

export const reserve = (at: Date, usd: number) => reserveWeekly(redis(), at, usd, limit, budgetKey);
export const release = (at: Date, usd: number) =>
  createRedisWeeklyBudget(redis(), { keyPrefix: budgetKey }).releaseUsd(usd, at);
export const loginPrefix = prefix ?? "incidentpulse";
