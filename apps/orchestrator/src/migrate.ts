/**
 * One-shot database migration. Runs with the bootstrap (owner) role and is the ONLY thing that does:
 *   1. creates/updates every table and trigger (journal, approvals + audit + guard, LangGraph checkpoints);
 *   2. creates the two least-privilege login roles and grants them exactly what they need.
 *
 *   incidentpulse_app  the orchestrator: SELECT/INSERT/UPDATE/DELETE on the tables, no DDL.
 *   incidentpulse_web  the web UI: SELECT on what it shows, UPDATE of the approval DECISION columns only,
 *                      plus EXECUTE on two scoped incident chat functions.
 *
 * compose.prod.yaml: `docker compose --profile migrate run --rm migrate` (docs/DEPLOY.md). The runtime services
 * never get the bootstrap role's password.
 */
import { setupApprovalSchema } from "@incidentpulse/mcp-actions/approvals";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { createJournal } from "./journal.ts";

export const APP_ROLE = "incidentpulse_app";
export const WEB_ROLE = "incidentpulse_web";

const SAFE_PASSWORD = /^[A-Za-z0-9_-]{32,}$/;

const WEB_GRANTS = [
  `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${WEB_ROLE}`,
  `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${WEB_ROLE}`,
  `GRANT USAGE ON SCHEMA public TO ${WEB_ROLE}`,
  `GRANT SELECT ON incidentpulse_incidents, incidentpulse_events, incidentpulse_postmortems TO ${WEB_ROLE}`,
  // Approvals: everything the page and the decision need, but not token_hash / token_expires_at.
  `GRANT SELECT (id, incident_id, project, check_name, attempt, runbook_id, params, risk, dry_run_output,
     details, status, created_at, expires_at, notified_at, decided_at, decided_by, consumed_at, execution,
     closed_at, plan_digest, policy_digest, plan_summary, plan_mac)
     ON incidentpulse_approvals TO ${WEB_ROLE}`,
  // The human decision, and nothing else on the approval row.
  `GRANT UPDATE (status, decided_by, decided_at) ON incidentpulse_approvals TO ${WEB_ROLE}`,
] as const;

async function upsertRole(pool: Pool, role: string, password: string) {
  if (!SAFE_PASSWORD.test(password)) {
    throw new Error(`${role}: password must be at least 32 characters of A-Z a-z 0-9 _ -`);
  }
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
  // role and password are validated constants/charset above: nothing user-controlled reaches this SQL.
  await pool.query(
    `${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${password}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
}

export async function migrate(options: {
  databaseUrl: string;
  appPassword: string;
  webPassword: string;
  log?: (line: string) => void;
}) {
  const log = options.log ?? (() => undefined);
  const pool = new Pool({ connectionString: options.databaseUrl, max: 2 });
  try {
    await createJournal(pool).setup();
    await setupApprovalSchema(pool);
    await pool.query(`
      WITH closed AS (
        UPDATE incidentpulse_approvals SET
          status=CASE WHEN status='pending' THEN 'expired' ELSE 'rejected' END,
          decided_at=COALESCE(decided_at, now()), decided_by=COALESCE(decided_by,'system'),
          closed_at=now()
        WHERE status IN ('pending','approved') AND closed_at IS NULL AND consumed_at IS NULL
          AND plan_digest IS NULL
        RETURNING id
      )
      INSERT INTO incidentpulse_action_audit(approval_id,event,actor,at,detail)
        SELECT id,'closed_legacy_plan','system',now(),'{}'::jsonb FROM closed
    `);
    const checkpointer = PostgresSaver.fromConnString(options.databaseUrl);
    await checkpointer.setup();
    await checkpointer.end();
    log("tables and triggers are up to date");

    await upsertRole(pool, APP_ROLE, options.appPassword);
    await upsertRole(pool, WEB_ROLE, options.webPassword);
    await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    // Tables created by later migrations (run by this role) stay reachable for the app role.
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
    );
    for (const statement of WEB_GRANTS) await pool.query(statement);
    for (const signature of [
      "public.incidentpulse_take_question(text)",
      "public.incidentpulse_charge_question(text, integer)",
    ]) {
      await pool.query(`ALTER FUNCTION ${signature} SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp`);
      await pool.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
      await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${WEB_ROLE}`);
    }
    log(`roles ${APP_ROLE} and ${WEB_ROLE} are configured`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const appPassword = process.env.APP_DB_PASSWORD ?? "";
  const webPassword = process.env.WEB_DB_PASSWORD ?? "";
  if (!databaseUrl) {
    console.error("DATABASE_URL (bootstrap role) is required");
    process.exit(1);
  }
  try {
    await migrate({
      databaseUrl,
      appPassword,
      webPassword,
      log: (line) => console.log(`migrate: ${line}`),
    });
  } catch (error) {
    // The message names the problem (a role, a missing password), never a connection string.
    console.error(`migrate failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  }
}
