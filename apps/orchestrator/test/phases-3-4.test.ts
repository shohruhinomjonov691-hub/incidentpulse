import { randomBytes } from "node:crypto";
import { KNOWN_PRICING, type ModelPricing } from "@incidentpulse/config";
import {
  createApprovalStore,
  dryRun,
  loadRunbookRegistry,
  localPlan,
  type RemoteExecutor,
} from "@incidentpulse/mcp-actions";
import { createRedactor } from "@incidentpulse/redact";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createActionControls, createActionFlow } from "../src/action-flow.ts";
import { buildIncidentGraph, toIncidentState } from "../src/graph.ts";
import { createRemediationProposer } from "../src/remediation-proposer.ts";
import { resumeIncident, runIncident } from "../src/run.ts";
import { job, makeMocks, NOW } from "./helpers.ts";
import { finalText, ScriptedModel } from "./scripted-model.ts";

test("low debate confidence sends missing facts back to specialists and verifies again", async () => {
  const m = makeMocks({ specialists: { code: { available: false } } });
  const verify = vi
    .fn()
    .mockResolvedValueOnce({
      verdict: {
        hypothesisId: "h1",
        confidence: 0.45,
        dissent: "thin",
        missing: ["certificate chain"],
      },
      costUsd: 0.001,
    })
    .mockResolvedValueOnce({
      verdict: { hypothesisId: "h1", confidence: 0.95, dissent: "", missing: [] },
      costUsd: 0.001,
    });
  const inspect = vi.spyOn(m.specialists.infra, "investigate");
  const { state } = await runIncident(
    buildIncidentGraph({ ...m.deps, debate: { mode: "auto", client: { verify } } }),
    job(),
  );
  expect(state.iteration).toBe(1);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(inspect.mock.calls[1]?.[0]?.missing).toEqual(["certificate chain"]);
  expect(
    state.trace
      .filter((e) => e.node === "verify" || e.node === "reinvestigate")
      .map((e) => e.event),
  ).toEqual(["debate_verdict", "collect_missing", "debate_verdict"]);
  expect(state.verdict?.confidence).toBe(0.95);
  expect(new Set(state.evidence.map((e) => e.id)).size).toBe(state.evidence.length);
  expect(toIncidentState(state).verdict?.hypothesisId).toBe("h1");
});

test("debate outage leaves a trace and continues without a verdict", async () => {
  const m = makeMocks();
  const { state } = await runIncident(
    buildIncidentGraph({
      ...m.deps,
      debate: {
        mode: "always",
        client: {
          async verify() {
            throw new Error("timeout");
          },
        },
      },
    }),
    job(),
  );
  expect(state.trace.some((e) => e.event === "debate_unavailable")).toBe(true);
  expect(state.verdict).toBeNull();
  expect(state.reportSent).toBeDefined();
});

test("TLS mismatch can propose medium-risk issuance only after the inventory dry run passes", async () => {
  const m = makeMocks();
  const { state } = await runIncident(buildIncidentGraph(m.deps), job());
  const registry = loadRunbookRegistry({
    kervan: { domains: ["kervan.uz"], webroot: "/srv/www/acme" },
  });
  const proposer = createRemediationProposer({
    registry,
    redact: m.deps.redact,
    pricing: KNOWN_PRICING["gpt-5.4-mini"] as ModelPricing,
    model: new ScriptedModel([
      finalText(
        JSON.stringify({
          runbookId: "certbot_nginx_issue",
          params: [{ name: "domain", value: "kervan.uz" }],
        }),
      ),
    ]),
  });
  const book = (await proposer(state)).book;
  if (!book) throw new Error("Missing issuance proposal");
  const alreadyConfigured = vi.fn(async ({ program }: { program: string }) =>
    program === "certbot" ? "Domains: kervan.uz" : "server_name kervan.uz;",
  );
  expect((await dryRun(book, alreadyConfigured, m.deps.redact)).ok).toBe(false);
  expect(alreadyConfigured).toHaveBeenCalledTimes(2);

  const missing = vi.fn(async () => "");
  expect((await dryRun(book, missing, m.deps.redact)).ok).toBe(true);
  expect(missing.mock.calls[2]).toMatchObject([{ program: "nginx", args: ["-t"] }]);
});

const databaseUrl = process.env.IT_DATABASE_URL;
const redisUrl = process.env.IT_REDIS_URL;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const testOutputSecret = "plain-output-value-that-must-not-persist";

async function fixture(remote?: RemoteExecutor) {
  const suffix = randomBytes(6).toString("hex");
  const schema = `it_phase${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  cleanup.push(async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  const pool = new Pool({ connectionString: databaseUrl, options: `-csearch_path=${schema}` });
  cleanup.push(() => pool.end());
  const redis = new Redis(redisUrl as string);
  const prefix = `it:${suffix}`;
  cleanup.push(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  const controls = createActionControls(redis, prefix);
  let time = NOW.getTime();
  const secret = "phase-4-test-secret".repeat(3);
  const approvals = createApprovalStore(pool, secret, () => new Date(time));
  await approvals.setup();
  const m = makeMocks();
  const buttons: string[] = [];
  const send = m.notifier.send;
  const notify = {
    async send(text: string, keyboard?: import("@incidentpulse/telegram-bot").TelegramButtons) {
      if (keyboard)
        buttons.push(
          ...keyboard
            .flat()
            .flatMap((button) => ("callback_data" in button ? [button.callback_data] : [])),
        );
      return send(text);
    },
  };
  const registry = loadRunbookRegistry({
    kervan: { domains: ["kervan.uz"], containers: ["toy-app"] },
  });
  const runner = vi.fn(async () => "ok");
  const flow = await createActionFlow({
    approvals,
    registry,
    controls,
    run: runner,
    ...(remote ? { remote } : {}),
    redact: remote ? createRedactor({ secrets: [testOutputSecret] }) : m.deps.redact,
    notifier: notify,
    callbackSecret: secret,
  });
  cleanup.push(() => flow.close());
  const recover = vi.fn(async () => ({ ok: true, check: "https" }));
  const book = registry.resolve("kervan", {
    runbookId: "docker_restart",
    params: { service: "toy-app" },
  });
  const graph = buildIncidentGraph({
    ...m.deps,
    controls,
    notifier: notify,
    actions: {
      flow,
      recover,
      propose: async () => ({ book, costUsd: 0 }),
    },
  });
  return {
    graph,
    m,
    pool,
    approvals,
    controls,
    flow,
    runner,
    buttons,
    recover,
    advance: (minutes: number) => {
      time += minutes * 60_000;
    },
  };
}

describe.skipIf(!databaseUrl || !redisUrl)(
  "approval workflow with mock agents, Telegram and executor",
  () => {
    test("blocks at interrupt, verifies a signed decision, executes once, then reports recovery", async () => {
      const f = await fixture();
      const first = await runIncident(f.graph, job());
      expect(first.mode).toBe("waiting");
      expect(first.state.approval?.status).toBe("pending");
      expect(f.m.notifier.sent[0]).toMatch(
        /project: kervan\nrunbook: docker_restart\nservice: toy-app/,
      );
      expect(f.runner).toHaveBeenCalledOnce();
      expect(f.runner.mock.calls[0]).toMatchObject([
        { program: "docker", args: expect.arrayContaining(["inspect", "toy-app"]) },
      ]);
      expect(await f.flow.callback(`${f.buttons[0]}X`, 42)).toMatchObject({
        answer: expect.stringContaining("imzosi"),
      });
      expect(await f.flow.callback(f.buttons[0] as string, 42)).toMatchObject({ resolved: true });
      const request = {
        incidentId: first.state.incidentId,
        approvalId: first.state.approvalId as string,
      };
      const done = await resumeIncident(f.graph, request);
      expect(done.state?.workflowStatus).toBe("recovered");
      expect(f.m.notifier.sent.at(-1)).toContain("🟢");
      expect(f.runner.mock.calls[1]).toEqual([{ program: "docker", args: ["restart", "toy-app"] }]);
      await resumeIncident(f.graph, request);
      expect(f.runner).toHaveBeenCalledTimes(2);
      const audit = await f.pool.query(
        "SELECT event,actor FROM incidentpulse_action_audit ORDER BY seq",
      );
      expect(audit.rows).toEqual([
        { event: "approved", actor: "42" },
        { event: "execution_claimed", actor: "42" },
        { event: "execution_finished", actor: "actions" },
      ]);
    });

    test("redacts remote output before it is shortened and persisted", async () => {
      const f = await fixture({
        plan: async (project, book) => localPlan(project, book),
        dryRun: async () => ({ ok: true, output: `${" ".repeat(1990)}${testOutputSecret}` }),
        execute: async () => ({ ok: true, output: `${"x".repeat(3990)} ${testOutputSecret}` }),
      });
      const { state } = await runIncident(f.graph, job());
      const id = state.approvalId as string;
      expect((await f.approvals.get(id))?.dryRunOutput).toBe("[REDACTED]");
      await f.flow.callback(f.buttons[0] as string, 42);
      const approved = await f.approvals.get(id);
      if (!approved) throw new Error("Missing approval");
      await f.flow.execute(approved);
      const output = (await f.approvals.get(id))?.execution?.output ?? "";
      expect(output).toHaveLength(4000);
      expect(output).toContain("[REDACTED");
      expect(output).not.toContain("plain-out");
      const audit = await f.pool.query<{ detail: { output: string } }>(
        "SELECT detail FROM incidentpulse_action_audit WHERE event='execution_finished'",
      );
      expect(audit.rows[0]?.detail.output).toBe(output);
    });

    test.each(["rejected", "expired"] as const)("%s cannot execute a runbook", async (status) => {
      const f = await fixture();
      const { state } = await runIncident(f.graph, job());
      if (status === "rejected") await f.flow.callback(f.buttons[1] as string, 42);
      else {
        f.advance(60);
        expect(await f.flow.callback(f.buttons[0] as string, 42)).not.toHaveProperty("resolved");
        await f.approvals.expire();
      }
      const done = await resumeIncident(f.graph, {
        incidentId: state.incidentId,
        approvalId: state.approvalId as string,
      });
      expect(done.state?.approval?.status).toBe(status);
      expect(done.state?.workflowStatus).toBe(status === "expired" ? "waiting_human" : "rejected");
      expect(f.runner).toHaveBeenCalledOnce();
      if (status === "expired") {
        await f.approvals.markResumed(state.approvalId as string);
        f.advance(120);
        await f.flow.remind();
        await f.flow.remind();
        expect(f.m.notifier.sent).toHaveLength(3);
      }
    });

    test("a persisted approval cannot execute while stopped and resumes once the flag clears", async () => {
      const f = await fixture();
      const { state } = await runIncident(f.graph, job());
      await f.flow.callback(f.buttons[0] as string, 42);
      await f.controls.setStopped(true);
      const awaiting = await resumeIncident(f.graph, {
        incidentId: state.incidentId,
        approvalId: state.approvalId as string,
      });
      expect(awaiting.paused).toBe(true);
      expect(f.runner).toHaveBeenCalledOnce();
      await f.controls.setStopped(false);
      const outcome = await resumeIncident(f.graph, { incidentId: state.incidentId });
      expect(outcome.state?.workflowStatus).toBe("recovered");
      expect(f.runner).toHaveBeenCalledTimes(2);
    });

    test("binds a 15-minute token to exact runbook params and consumes it atomically", async () => {
      const f = await fixture();
      const { state } = await runIncident(f.graph, job());
      await f.flow.callback(f.buttons[0] as string, 42);
      const approval = await f.approvals.get(state.approvalId as string);
      if (!approval) throw new Error("Missing approval");
      const token = (await f.approvals.issueToken(approval)) as string;
      const request = {
        approvalId: approval.id,
        incidentId: approval.incidentId,
        project: approval.project,
        runbookId: approval.runbookId,
        params: approval.params,
        approvalToken: token,
        planDigest: approval.planDigest as string,
      };
      expect(await f.approvals.claim({ ...request, params: { service: "different" } })).toBe(false);
      f.advance(14);
      const claims = await Promise.all([f.approvals.claim(request), f.approvals.claim(request)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    test("an approval token expires before execution at the 15-minute cutoff", async () => {
      const f = await fixture();
      const { state } = await runIncident(f.graph, job());
      await f.flow.callback(f.buttons[0] as string, 42);
      const approval = await f.approvals.get(state.approvalId as string);
      if (!approval) throw new Error("Missing approval");
      const token = (await f.approvals.issueToken(approval)) as string;
      f.advance(15);
      expect(
        await f.approvals.claim({
          approvalId: approval.id,
          incidentId: approval.incidentId,
          project: approval.project,
          runbookId: approval.runbookId,
          params: approval.params,
          approvalToken: token,
          planDigest: approval.planDigest as string,
        }),
      ).toBe(false);
    });

    test("stopped graphs resume from checkpoints", async () => {
      const f = await fixture();
      await f.controls.setStopped(true);
      const { state, mode } = await runIncident(f.graph, job());
      expect(mode).toBe("waiting");
      expect(f.m.triage.calls).toBe(0);
      expect(await f.controls.pausedIncidents()).toEqual([state.incidentId]);
      await f.controls.setStopped(false);
      const resumed = await resumeIncident(f.graph, { incidentId: state.incidentId });
      expect(resumed.state?.approval?.status).toBe("pending");
      expect(f.m.triage.calls).toBe(1);
      expect(resumed.paused).toBe(false);
    });
  },
);
