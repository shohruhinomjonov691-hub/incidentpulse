import { type RunnerClient, RunnerError } from "@incidentpulse/runner-client";
import type { ProjectId } from "@incidentpulse/schemas";
import type { ExecutionResult } from "./approvals.ts";
import type { ResolvedRunbook } from "./registry.ts";

/**
 * Production executor: hands a resolved runbook to the host actions runner (systemd service, separate
 * Unix user, unix socket). The runner owns the commands, verifies the approval token itself and keeps
 * its own single-use ledger, so a compromised orchestrator still cannot run anything outside its policy.
 */
export interface RemoteExecutor {
  dryRun(project: ProjectId, book: ResolvedRunbook): Promise<ExecutionResult>;
  execute(
    request: {
      project: ProjectId;
      incidentId: string;
      approvalId: string;
      approvalToken: string;
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
          tokenExpiresAt: request.tokenExpiresAt,
        });
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
