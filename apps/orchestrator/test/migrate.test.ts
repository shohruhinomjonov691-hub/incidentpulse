import { randomBytes } from "node:crypto";
import {
  createApprovalCallbacks,
  createApprovalDecisions,
  createApprovalStore,
  localPlan,
} from "@incidentpulse/mcp-actions";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { createJournal } from "../src/journal.ts";
import { APP_ROLE, migrate, WEB_ROLE } from "../src/migrate.ts";

const databaseUrl = process.env.IT_DATABASE_URL;
const denied = { code: "42501" };

test.skipIf(!databaseUrl)(
  "migration binds approval plans and grants only web decisions and reads",
  async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const name = `it_roles_${randomBytes(6).toString("hex")}`;
    const bootstrap = new URL(databaseUrl as string);
    bootstrap.pathname = `/${name}`;
    const appPassword = randomBytes(32).toString("hex");
    const webPassword = randomBytes(32).toString("hex");
    const executionKey = randomBytes(32).toString("hex");
    const callbackKey = randomBytes(32).toString("hex");
    const rolePool = (user: string, password: string) => {
      const url = new URL(bootstrap);
      url.username = user;
      url.password = password;
      return new Pool({ connectionString: url.href });
    };
    const owner = new Pool({ connectionString: bootstrap.href });
    const app = rolePool(APP_ROLE, appPassword);
    const web = rolePool(WEB_ROLE, webPassword);
    const existing = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ($1,$2)",
      [APP_ROLE, WEB_ROLE],
    );
    try {
      expect(existing.rows).toEqual([]);
      await admin.query(`CREATE DATABASE ${name}`);
      const options = { databaseUrl: bootstrap.href, appPassword, webPassword };
      await migrate(options);
      await owner.query(`INSERT INTO incidentpulse_approvals
      (id,incident_id,project,check_name,attempt,runbook_id,params,risk,dry_run_output,details,created_at,expires_at)
      VALUES('legacy','legacy-incident','kervan','https',0,'pm2_restart','{}','low','','',now(),now()+interval '1 hour')`);
      await migrate(options); // Same command is used for initial deploy and updates.
      expect(
        (await owner.query("SELECT status FROM incidentpulse_approvals WHERE id='legacy'")).rows,
      ).toEqual([{ status: "expired" }]);

      const store = createApprovalStore(app, executionKey);
      const book = {
        runbookId: "pm2_restart" as const,
        params: { app: "KERVAN" },
        dryRun: [],
        run: [],
      };
      const plan = localPlan("kervan", book);
      const approval = await store.prepare({
        ...book,
        incidentId: "it-incident",
        project: "kervan",
        check: "https",
        attempt: 0,
        risk: "low",
        dryRunOutput: "ok",
        details: "",
        planDigest: plan.planDigest,
        policyDigest: plan.policyDigest,
        planSummary: plan.summary,
      });
      const callback = createApprovalCallbacks(callbackKey).encode(approval.id, "a");
      expect(createApprovalCallbacks(executionKey).decode(callback)).toBeUndefined();
      expect(createApprovalCallbacks(callbackKey).decode(callback)).toEqual({
        id: approval.id,
        action: "a",
      });

      const decisions = createApprovalDecisions(web);
      expect(await decisions.get(approval.id)).toMatchObject({
        project: "kervan",
        params: { app: "KERVAN" },
        planDigest: plan.planDigest,
      });
      expect(await decisions.decide(approval.id, "approved", "web:admin")).toBe(true);
      expect(await decisions.decide(approval.id, "rejected", "web:admin")).toBe(false);
      const decided = await store.get(approval.id);
      if (!decided) throw new Error("Missing approval");
      expect(await store.issueToken(decided)).toEqual(expect.any(String));
      expect(await store.issueToken({ ...decided, params: { app: "OTHER" } })).toBeUndefined();

      const audit = await owner.query(
        "SELECT event,actor FROM incidentpulse_action_audit WHERE approval_id=$1",
        [approval.id],
      );
      expect(audit.rows).toEqual([{ event: "approved", actor: "web:admin" }]);
      for (const column of [
        "params",
        "plan_digest",
        "token_hash",
        "token_expires_at",
        "execution",
      ]) {
        await expect(
          web.query(`UPDATE incidentpulse_approvals SET ${column} = NULL`),
        ).rejects.toMatchObject(denied);
      }
      await expect(
        web.query("SELECT token_hash FROM incidentpulse_approvals"),
      ).rejects.toMatchObject(denied);
      await expect(web.query("SELECT * FROM incidentpulse_action_audit")).rejects.toMatchObject(
        denied,
      );
      await expect(web.query("SELECT * FROM checkpoints")).rejects.toMatchObject(denied);
      await expect(
        web.query("INSERT INTO incidentpulse_events DEFAULT VALUES"),
      ).rejects.toMatchObject(denied);
      await expect(
        web.query("UPDATE incidentpulse_incidents SET questions=0"),
      ).rejects.toMatchObject(denied);
      await expect(web.query("CREATE TABLE public.disallowed(id int)")).rejects.toMatchObject(
        denied,
      );
      await expect(app.query("CREATE TABLE public.disallowed(id int)")).rejects.toMatchObject(
        denied,
      );

      await owner.query(`INSERT INTO incidentpulse_incidents(id,project,started_at,state)
      VALUES('it-incident','kervan',now(),'{}'::jsonb)`);
      const journal = createJournal(web);
      expect(await journal.takeQuestion("it-incident")).toBe(true);
      await journal.chargeQuestion("it-incident", 1200);
      expect(await journal.get("it-incident")).toMatchObject({ cost: 0.0012 });
      expect((await owner.query("SELECT kind,data FROM incidentpulse_events")).rows).toEqual([
        { kind: "chat_cost", data: { costUsd: 0.0012 } },
      ]);
    } finally {
      await Promise.all([web.end(), app.end(), owner.end()]);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      if (!existing.rows.length) await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}, ${WEB_ROLE}`);
      await admin.end();
    }
  },
);
