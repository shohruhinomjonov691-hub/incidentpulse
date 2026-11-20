import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProjectId, RunbookId } from "@incidentpulse/schemas";
import type { Pool } from "pg";
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
>;

const SELECTION = `id, incident_id AS "incidentId", project, check_name AS "check", attempt,
  runbook_id AS "runbookId", params, risk, dry_run_output AS "dryRunOutput", details, status,
  created_at AS "createdAt", expires_at AS "expiresAt", decided_at AS "decidedAt",
  decided_by AS "decidedBy", notified_at AS "notifiedAt", consumed_at AS "consumedAt", execution`;
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
}

export function createApprovalStore(pool: Pool, secret: string, now = () => new Date()) {
  if (Buffer.byteLength(secret) < 32) throw new Error("Approval HMAC secret is too short");

  const expiryOf = (approval: Approval) =>
    new Date((approval.decidedAt?.getTime() ?? 0) + TOKEN_MINUTES * 60_000);
  const tokenFor = (approval: Approval) =>
    sign(secret, [
      "runbook",
      approval.id,
      approval.incidentId,
      approval.project,
      approval.runbookId,
      Object.entries(approval.params).sort(([a], [b]) => a.localeCompare(b)),
      expiryOf(approval).getTime(),
    ]);

  return {
    async setup() {
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
        CREATE TABLE IF NOT EXISTS incidentpulse_action_audit (
          seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          approval_id text NOT NULL REFERENCES incidentpulse_approvals(id),
          event text NOT NULL, actor text NOT NULL, at timestamptz NOT NULL, detail jsonb NOT NULL
        );
      `);
    },

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

    async prepare(input: NewApproval): Promise<Approval> {
      const id = randomBytes(12).toString("base64url");
      const created = now();
      const expires = new Date(created.getTime() + APPROVAL_MINUTES * 60_000);
      const { rows } = await pool.query<Approval>(
        `
        INSERT INTO incidentpulse_approvals
          (id,incident_id,project,check_name,attempt,runbook_id,params,risk,dry_run_output,details,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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

    async decide(id: string, decision: "approved" | "rejected", userId: number) {
      const at = now();
      const { rowCount } = await pool.query(
        `
        WITH changed AS (
          UPDATE incidentpulse_approvals SET status=$2, decided_by=$3, decided_at=$4
          WHERE id=$1 AND status='pending' AND expires_at>$4 AND closed_at IS NULL
          RETURNING id, runbook_id, params
        )
        INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
          SELECT id,$2,$3,$4,jsonb_build_object('runbookId',runbook_id,'params',params) FROM changed
      `,
        [id, decision, String(userId), at],
      );
      return rowCount === 1;
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
      const expires = expiryOf(approval);
      const token = tokenFor(approval);
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
