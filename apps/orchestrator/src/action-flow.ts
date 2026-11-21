import {
  type ActionRunner,
  type Approval,
  type ApprovalStore,
  createActionsServer,
  createApprovalCallbacks,
  dryRun,
  ExecutionResultSchema,
  type RemoteExecutor,
  type ResolvedRunbook,
  type RunbookRegistry,
} from "@incidentpulse/mcp-actions";
import type { Redactor } from "@incidentpulse/redact";
import { PROJECT_DISPLAY_NAMES, type ProjectId } from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Redis } from "ioredis";
import type { GraphState } from "./graph.ts";
import { formatReport } from "./report.ts";

export function createActionControls(redis: Redis, prefix = "incidentpulse") {
  const flag = `${prefix}:kill-switch`;
  const paused = `${prefix}:paused-graphs`;
  return {
    async isStopped() {
      return (await redis.get(flag)) === "1";
    },
    async setStopped(value: boolean) {
      if (value) await redis.set(flag, "1");
      else await redis.del(flag);
    },
    async markPaused(id: string) {
      await redis.sadd(paused, id);
    },
    async clearPaused(id: string) {
      await redis.srem(paused, id);
    },
    async pausedIncidents() {
      return redis.smembers(paused);
    },
  };
}
export type ActionControls = ReturnType<typeof createActionControls>;

export async function createActionFlow(options: {
  approvals: ApprovalStore;
  registry: RunbookRegistry;
  controls: ActionControls;
  /** Local step runner (sandbox, tests). Production passes `remote` instead. */
  run?: ActionRunner;
  /** Production: the host actions runner. */
  remote?: RemoteExecutor;
  redact: Redactor;
  notifier: Notifier;
  callbackSecret: string;
}) {
  const { approvals, registry, controls, remote, redact, notifier } = options;
  const run: ActionRunner =
    options.run ??
    (async () => {
      throw new Error("No local action runner is configured");
    });
  const callbacks = createApprovalCallbacks(options.callbackSecret);
  const server = createActionsServer({
    registry,
    approvals,
    ...(options.run ? { run: options.run } : {}),
    ...(remote ? { remote } : {}),
    redact,
    isStopped: controls.isStopped,
  });
  const client = new Client({ name: "incidentpulse-orchestrator", version: "1.0.0" });
  const [outgoing, incoming] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming);
  await client.connect(outgoing);

  return {
    approvals,
    controls,
    dryRun: (book: ResolvedRunbook, project: ProjectId) =>
      remote ? remote.dryRun(project, book) : dryRun(book, run, redact),
    async notify(
      approval: Approval,
      state: GraphState,
      budgetUsd: number,
      weeklyBudgetUsd: number,
    ) {
      if (approval.notifiedAt || approval.status !== "pending") return;
      const tag = Object.values(approval.params).join(", ");
      const report = formatReport({
        ...state,
        verdict: state.verdict ?? undefined,
        budgetUsd,
        weeklyBudgetUsd,
      }).replace(
        /^Taklif: .+$/m,
        `Taklif: ${approval.runbookId}(${tag}) · ${approval.risk} · dry-run ✅`,
      );
      await notifier.send(redact(report), [
        [
          { text: "✅ Bajar", callback_data: callbacks.encode(approval.id, "a") },
          { text: "❌ Rad et", callback_data: callbacks.encode(approval.id, "r") },
          { text: "🔍 Batafsil", callback_data: callbacks.encode(approval.id, "d") },
        ],
      ]);
      await approvals.markNotified(approval.id);
    },
    async execute(approval: Approval) {
      if (approval.execution) return approval.execution;
      if (approval.consumedAt)
        return { ok: false, output: "Previous execution outcome is unknown" };
      const approvalToken = await approvals.issueToken(approval);
      if (!approvalToken) return { ok: false, output: "Approval token expired or already used" };
      const result = await client.callTool(
        {
          name: "execute_runbook",
          arguments: {
            approvalId: approval.id,
            incidentId: approval.incidentId,
            project: approval.project,
            runbookId: approval.runbookId,
            params: approval.params,
            approvalToken,
            tokenExpiresAt: approvals.tokenExpiry(approval),
          },
        },
        undefined,
        { timeout: 600_000 },
      );
      return ExecutionResultSchema.parse(result.structuredContent);
    },
    async callback(data: string, userId: number) {
      const parsed = callbacks.decode(data);
      if (!parsed) return { answer: "Tugma imzosi yaroqsiz." };
      const row = await approvals.get(parsed.id);
      if (!row) return { answer: "Taklif topilmadi." };
      if (parsed.action === "d") {
        return {
          answer: "Tafsilot yuborildi.",
          details: redact(
            [row.details, `Runbook: ${row.runbookId}`, `Dry-run: ${row.dryRunOutput}`].join("\n"),
          ),
        };
      }
      const accepted = await approvals.decide(
        row.id,
        parsed.action === "a" ? "approved" : "rejected",
        userId,
      );
      if (!accepted) return { answer: "Taklif allaqachon ko‘rilgan yoki muddati o‘tgan." };
      return { answer: parsed.action === "a" ? "Tasdiqlandi." : "Rad etildi.", resolved: true };
    },
    async remind() {
      for (const row of await approvals.reminders()) {
        await notifier.send(
          `🟠 ${PROJECT_DISPLAY_NAMES[row.project]} · #${row.incidentId} · inson ko‘rigi kutilmoqda.`,
        );
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
export type ActionFlow = Awaited<ReturnType<typeof createActionFlow>>;
