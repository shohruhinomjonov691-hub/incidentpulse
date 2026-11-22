import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProjectId, RunbookId } from "@incidentpulse/schemas";
import type { Pool } from "pg";
import { normalizeParams, planDigest } from "./plan.ts";
import type { RunbookChoice, RunbookRisk } from "./registry.ts";

export type Decision = "approved" | "rejected" | "expired";
export interface ExecutionResult {
  ok: boolean;
  output: string;
}
export interface Approval {
  id: string;
  incidentId: string;
  project: ProjectId;
  check: string;
  attempt: number;
  runbookId: RunbookId;
  params: Record<string, string>;
  risk: RunbookRisk;
  dryRunOutput: string;
  details: string;
  status: "pending" | Decision;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  notifiedAt: Date | null;
  consumedAt: Date | null;
  execution: ExecutionResult | null;
  /** sha256 of the canonical plan shown to the human (src/plan.ts); null on rows created before plan digests. */
  planDigest: string | null;
  policyDigest: string | null;
  /** Target, parameters and exact commands in words: what the Telegram and web cards show. */
  planSummary: string | null;
  /** HMAC (APPROVAL_HMAC_SECRET, which the web UI never has) over the row's plan: detects a rewritten row. */
  planMac: string | null;
}
type NewApproval = Pick<
  Approval,
  | "incidentId"
  | "project"
  | "check"
  | "attempt"
  | "runbookId"
  | "params"
  | "risk"
  | "dryRunOutput"
  | "details"
> & { planDigest: string; policyDigest: string; planSummary: string };

const SELECTION = `id, incident_id AS "incidentId", project, check_name AS "check", attempt,
  runbook_id AS "runbookId", params, risk, dry_run_output AS "dryRunOutput", details, status,
  created_at AS "createdAt", expires_at AS "expiresAt", decided_at AS "decidedAt",
  decided_by AS "decidedBy", notified_at AS "notifiedAt", consumed_at AS "consumedAt", execution,
  plan_digest AS "planDigest", policy_digest AS "policyDigest", plan_summary AS "planSummary",
  plan_mac AS "planMac"`;
const APPROVAL_MINUTES = 60;
const TOKEN_MINUTES = 15;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const sign = (secret: string, value: unknown) =>
  createHmac("sha256", secret).update(JSON.stringify(value)).digest("base64url");
const safeEqual = (a: string, b: string) => {
  const got = Buffer.from(a);
  const want = Buffer.from(b);
  return got.length === want.length && timingSafeEqual(got, want);
};

export interface ExecutionRequest extends RunbookChoice {
  approvalId: string;
  incidentId: string;
  project: ProjectId;
  approvalToken: string;
  /** The plan digest the approval row carries; the claim only succeeds for the same one. */
  planDigest: string;
}

/**
 * The execution token. Must stay byte-identical to `signApproval` in host/actions-runner/src/token.ts
 * (contract test in host/actions-runner/test/token.test.ts). Key: APPROVAL_HMAC_SECRET.
 */
export function signExecutionToken(
  secret: string,
  claims: {
    approvalId: string;
    incidentId: string;
    project: string;
    runbookId: string;
    params: Record<string, string>;
    planDigest: string;
    tokenExpiresAt: number;
  },
): string {
  return sign(secret, [
    "runbook",
    claims.approvalId,
    claims.incidentId,
    claims.project,
    claims.runbookId,
    Object.entries(claims.params).sort(([a], [b]) => a.localeCompare(b)),
    claims.planDigest,
    claims.tokenExpiresAt,
  ]);
}

/**
 * Schema and the two triggers that keep approval decisions honest. Run by the migration role only (the web
 * and the orchestrator roles hold no DDL rights, see apps/orchestrator/src/migrate.ts).
 *  - audit trigger: a human decision (pending -> approved/rejected on an open row) is audited by the
 *    database itself, so it is recorded whichever role made it and the web role needs no audit INSERT.
 *  - guard trigger: only pending -> approved/rejected/expired and approved -> rejected are legal, so a
 *    compromised writer cannot revive a rejected or expired approval.
 */
export async function setupApprovalSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidentpulse_approvals (
      id text PRIMARY KEY, incident_id text NOT NULL, project text NOT NULL, check_name text NOT NULL,
      attempt integer NOT NULL, runbook_id text NOT NULL, params jsonb NOT NULL, risk text NOT NULL,
      dry_run_output text NOT NULL, details text NOT NULL, status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, notified_at timestamptz,
      decided_at timestamptz, decided_by text, token_hash text, token_expires_at timestamptz,
      consumed_at timestamptz, execution jsonb, resumed_at timestamptz,
      next_reminder_at timestamptz, closed_at timestamptz,
      UNIQUE (incident_id, attempt),
      CHECK (status IN ('pending','approved','rejected','expired'))
    );
    ALTER TABLE incidentpulse_approvals
      ADD COLUMN IF NOT EXISTS plan_digest text, ADD COLUMN IF NOT EXISTS policy_digest text,
      ADD COLUMN IF NOT EXISTS plan_summary text, ADD COLUMN IF NOT EXISTS plan_mac text;
    CREATE TABLE IF NOT EXISTS incidentpulse_action_audit (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      approval_id text NOT NULL REFERENCES incidentpulse_approvals(id),
      event text NOT NULL, actor text NOT NULL, at timestamptz NOT NULL, detail jsonb NOT NULL
    );
    CREATE OR REPLACE FUNCTION incidentpulse_audit_decision() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected') AND NEW.closed_at IS NULL THEN
        EXECUTE format('INSERT INTO %I.incidentpulse_action_audit(approval_id,event,actor,at,detail)
          VALUES ($1,$2,$3,$4,$5)', TG_TABLE_SCHEMA)
        USING NEW.id, NEW.status, COALESCE(NEW.decided_by,'unknown'), COALESCE(NEW.decided_at, now()),
          jsonb_build_object('runbookId', NEW.runbook_id, 'params', NEW.params);
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE OR REPLACE FUNCTION incidentpulse_guard_status() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_user = 'incidentpulse_web' THEN
        IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved','rejected')
          OR OLD.closed_at IS NOT NULL OR OLD.expires_at <= statement_timestamp() THEN
          RAISE EXCEPTION 'web decision requires an open pending approval';
        END IF;
        NEW.decided_at := statement_timestamp();
        NEW.decided_by := 'web:admin';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status IN ('approved','rejected','expired'))
        OR (OLD.status = 'approved' AND NEW.status = 'rejected')
      ) THEN
        RAISE EXCEPTION 'illegal approval status transition % -> %', OLD.status, NEW.status;
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS incidentpulse_approvals_guard ON incidentpulse_approvals;
    CREATE TRIGGER incidentpulse_approvals_guard
      BEFORE UPDATE OF status, decided_at, decided_by ON incidentpulse_approvals
      FOR EACH ROW EXECUTE FUNCTION incidentpulse_guard_status();
    DROP TRIGGER IF EXISTS incidentpulse_approvals_audit ON incidentpulse_approvals;
    CREATE TRIGGER incidentpulse_approvals_audit AFTER UPDATE OF status ON incidentpulse_approvals
      FOR EACH ROW EXECUTE FUNCTION incidentpulse_audit_decision();
  `);
}

/**
 * What the web UI may do with approvals: read a row and record the human decision. No signing key, no
 * token, no execution. The database role the web runs as can update only the decision columns.
 */
export function createApprovalDecisions(pool: Pool, now = () => new Date()) {
  return {
    async get(id: string) {
      const { rows } = await pool.query<Approval>(
        `SELECT ${SELECTION} FROM incidentpulse_approvals WHERE id=$1`,
        [id],
      );
      return rows[0];
    },

    async find(incidentId: string, attempt: number) {
      const { rows } = await pool.query<Approval>(
        `SELECT ${SELECTION} FROM incidentpulse_approvals
        WHERE incident_id=$1 AND attempt=$2`,
        [incidentId, attempt],
      );
      return rows[0];
    },

    /** The audit row is written by the database trigger (setupApprovalSchema), not by this statement. */
    async decide(id: string, decision: "approved" | "rejected", userId: number | "web:admin") {
      const { rowCount } = await pool.query(
        `UPDATE incidentpulse_approvals SET status=$2, decided_by=$3, decided_at=$4
         WHERE id=$1 AND status='pending' AND expires_at>$4 AND closed_at IS NULL`,
        [id, decision, String(userId), now()],
      );
      return rowCount === 1;
    },
  };
}

export function createApprovalStore(pool: Pool, secret: string, now = () => new Date()) {
  if (Buffer.byteLength(secret) < 32) throw new Error("Approval HMAC secret is too short");

  const expiryOf = (approval: Approval) =>
    new Date((approval.decidedAt?.getTime() ?? 0) + TOKEN_MINUTES * 60_000);
  const planMacOf = (row: {
    id: string;
    incidentId: string;
    project: string;
    runbookId: string;
    params: Record<string, string>;
    planDigest: string;
    policyDigest: string;
  }) =>
    sign(secret, [
      "plan",
      row.id,
      row.incidentId,
      row.project,
      row.runbookId,
      normalizeParams(row.params),
      row.planDigest,
      row.policyDigest,
    ]);
  /** True when the row still carries the plan the orchestrator signed when it was proposed. */
  const planIsIntact = (approval: Approval) =>
    !!approval.planDigest &&
    !!approval.policyDigest &&
    !!approval.planMac &&
    planDigest({ ...approval, policyDigest: approval.policyDigest }) === approval.planDigest &&
    safeEqual(
      approval.planMac,
      planMacOf({
        ...approval,
        planDigest: approval.planDigest,
        policyDigest: approval.policyDigest,
      }),
    );

  return {
    ...createApprovalDecisions(pool, now),
    /** Epoch ms at which the approval's token expires (the value the host runner verifies). */
    tokenExpiry: (approval: Approval) => expiryOf(approval).getTime(),
    planIsIntact,

    async setup() {
      await setupApprovalSchema(pool);
    },

    async prepare(input: NewApproval): Promise<Approval> {
      if (planDigest(input) !== input.planDigest) throw new Error("Approval plan digest mismatch");
      const id = randomBytes(12).toString("base64url");
      const created = now();
      const expires = new Date(created.getTime() + APPROVAL_MINUTES * 60_000);
      const planMac = planMacOf({
        id,
        incidentId: input.incidentId,
        project: input.project,
        runbookId: input.runbookId,
        params: input.params,
        planDigest: input.planDigest,
        policyDigest: input.policyDigest,
      });
      const { rows } = await pool.query<Approval>(
        `
        INSERT INTO incidentpulse_approvals
          (id,incident_id,project,check_name,attempt,runbook_id,params,risk,dry_run_output,details,created_at,expires_at,
           plan_digest,policy_digest,plan_summary,plan_mac)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (incident_id,attempt) DO UPDATE SET incident_id=EXCLUDED.incident_id
        RETURNING ${SELECTION}`,
        [
          id,
          input.incidentId,
          input.project,
          input.check,
          input.attempt,
          input.runbookId,
          input.params,
          input.risk,
          input.dryRunOutput,
          input.details,
          created,
          expires,
          input.planDigest,
          input.policyDigest,
          input.planSummary,
          planMac,
        ],
      );
      const approval = rows[0];
      if (!approval) throw new Error("Approval row was not persisted");
      return approval;
    },

    async markNotified(id: string) {
      await pool.query("UPDATE incidentpulse_approvals SET notified_at=$2 WHERE id=$1", [
        id,
        now(),
      ]);
    },

    async expire() {
      const at = now();
      await pool.query(
        `
        WITH changed AS (
          UPDATE incidentpulse_approvals SET status='expired', decided_by='system', decided_at=$1,
            next_reminder_at=$1::timestamptz+interval '2 hours'
          WHERE status='pending' AND expires_at<=$1 AND closed_at IS NULL RETURNING id, runbook_id, params
        )
        INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
          SELECT id,'expired','system',$1,jsonb_build_object('runbookId',runbook_id,'params',params) FROM changed
      `,
        [at],
      );
    },

    async pendingResumes() {
      const { rows } = await pool.query<Approval>(`SELECT ${SELECTION} FROM incidentpulse_approvals
        WHERE status<>'pending' AND resumed_at IS NULL
        ORDER BY decided_at,id LIMIT 50`);
      return rows;
    },

    async markResumed(id: string) {
      await pool.query("UPDATE incidentpulse_approvals SET resumed_at=$2 WHERE id=$1", [id, now()]);
    },

    async reminders() {
      const at = now();
      const { rows } = await pool.query<Approval>(
        `
        UPDATE incidentpulse_approvals SET next_reminder_at=$1::timestamptz+interval '2 hours'
        WHERE status='expired' AND next_reminder_at<=$1 AND closed_at IS NULL AND resumed_at IS NOT NULL
        RETURNING ${SELECTION}`,
        [at],
      );
      return rows;
    },

    async closeForRecovery(project: ProjectId, check: string) {
      const at = now();
      await pool.query(
        `
        WITH closed AS (
          UPDATE incidentpulse_approvals SET closed_at=$3,
            status=CASE WHEN status='expired' THEN status ELSE 'rejected' END,
            decided_at=COALESCE(decided_at,$3), decided_by=COALESCE(decided_by,'system')
          WHERE project=$1 AND check_name=$2 AND closed_at IS NULL
            AND (status IN ('pending','expired') OR (status='approved' AND consumed_at IS NULL))
          RETURNING id
        )
        INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
          SELECT id,'closed_on_recovery','system',$3,'{}'::jsonb FROM closed
      `,
        [project, check, at],
      );
    },

    async issueToken(approval: Approval): Promise<string | undefined> {
      if (approval.status !== "approved" || !approval.decidedAt) return;
      // The row must still be the plan the orchestrator signed at proposal time (a rewritten row is refused).
      if (!planIsIntact(approval) || !approval.planDigest) return;
      const expires = expiryOf(approval);
      const token = signExecutionToken(secret, {
        approvalId: approval.id,
        incidentId: approval.incidentId,
        project: approval.project,
        runbookId: approval.runbookId,
        params: approval.params,
        planDigest: approval.planDigest,
        tokenExpiresAt: expires.getTime(),
      });
      const { rowCount } = await pool.query(
        `
        UPDATE incidentpulse_approvals SET token_hash=$2, token_expires_at=$3
          WHERE id=$1 AND status='approved' AND consumed_at IS NULL AND closed_at IS NULL AND $3::timestamptz>$4
      `,
        [approval.id, tokenHash(token), expires, now()],
      );
      return rowCount === 1 ? token : undefined;
    },

    async claim(request: ExecutionRequest): Promise<boolean> {
      const at = now();
      const { rowCount } = await pool.query(
        `
        WITH claimed AS (
          UPDATE incidentpulse_approvals SET consumed_at=$7
          WHERE id=$1 AND incident_id=$2 AND project=$3 AND runbook_id=$4 AND params=$5 AND token_hash=$6
            AND plan_digest=$8
            AND status='approved' AND token_expires_at>$7 AND consumed_at IS NULL AND closed_at IS NULL
          RETURNING id,decided_by, runbook_id, params
        )
        INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
          SELECT id,'execution_claimed',decided_by,$7,jsonb_build_object('runbookId',runbook_id,'params',params)
          FROM claimed
      `,
        [
          request.approvalId,
          request.incidentId,
          request.project,
          request.runbookId,
          request.params,
          tokenHash(request.approvalToken),
          at,
          request.planDigest,
        ],
      );
      return rowCount === 1;
    },

    async complete(id: string, result: ExecutionResult) {
      await pool.query(
        `
        WITH completed AS (
          UPDATE incidentpulse_approvals SET execution=$2
            WHERE id=$1 AND consumed_at IS NOT NULL AND execution IS NULL RETURNING id
        )
        INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
          SELECT id,'execution_finished','actions',$3,$2 FROM completed
      `,
        [id, result, now()],
      );
    },
  };
}
export type ApprovalStore = ReturnType<typeof createApprovalStore>;

export type CallbackAction = "a" | "r" | "d";
export function createApprovalCallbacks(secret: string) {
  const signature = (id: string, action: CallbackAction) =>
    sign(secret, ["telegram", id, action]).slice(0, 22);
  return {
    encode: (id: string, action: CallbackAction) => `ip:${action}:${id}:${signature(id, action)}`,
    decode(value: string) {
      const match = /^ip:([ard]):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/.exec(value);
      if (!match) return;
      const action = match[1] as CallbackAction;
      const id = match[2] as string;
      if (safeEqual(match[3] as string, signature(id, action))) return { id, action };
    },
  };
}
