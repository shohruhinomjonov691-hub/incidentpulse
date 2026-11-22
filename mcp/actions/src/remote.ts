import { type RunnerClient, RunnerError } from "@incidentpulse/runner-client";
import type { ProjectId } from "@incidentpulse/schemas";
import type { ExecutionResult } from "./approvals.ts";
import type { PlanInfo } from "./plan.ts";
import type { ResolvedRunbook } from "./registry.ts";

/**
 * Production executor: hands a resolved runbook to the host actions runner (systemd service, separate
 * Unix user, unix socket). The runner owns the commands, verifies the approval token itself and keeps
 * its own single-use ledger, so a compromised orchestrator still cannot run anything outside its policy.
 */
export interface RemoteExecutor {
  /** The canonical plan from the runner's own policy, bound to the approval at proposal time. */
  plan(project: ProjectId, book: ResolvedRunbook): Promise<PlanInfo>;
  /** Static pre-approval checks only (see runner `dryRun`): nothing here touches the live nginx. */
  dryRun(project: ProjectId, book: ResolvedRunbook): Promise<ExecutionResult>;
  execute(
    request: {
      project: ProjectId;
      incidentId: string;
      approvalId: string;
      approvalToken: string;
      planDigest: string;
      tokenExpiresAt?: number | undefined;
    },
    book: ResolvedRunbook,
  ): Promise<ExecutionResult>;
}

export function createRemoteExecutor(client: RunnerClient): RemoteExecutor {
  const unavailable = (error: unknown): ExecutionResult => ({
    ok: false,
    output: `Host runner unavailable: ${error instanceof RunnerError ? error.code : "unknown error"}`,
  });
  return {
    async plan(project, book) {
      const plan = await client.plan({ project, runbookId: book.runbookId, params: book.params });
      return {
        planDigest: plan.planDigest,
        policyDigest: plan.policyDigest,
        summary: plan.summary.join("\n"),
      };
    },
    async dryRun(project, book) {
      try {
        return await client.dryRun({
          project,
          runbookId: book.runbookId,
          params: book.params,
        });
      } catch (error) {
        return unavailable(error);
      }
    },
    async execute(request, book) {
      if (!request.tokenExpiresAt) return { ok: false, output: "Token expiry is required" };
      try {
        return await client.execute({
          project: request.project,
          runbookId: book.runbookId,
          params: book.params,
          approvalId: request.approvalId,
          incidentId: request.incidentId,
          approvalToken: request.approvalToken,
          planDigest: request.planDigest,
          tokenExpiresAt: request.tokenExpiresAt,
        });
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
