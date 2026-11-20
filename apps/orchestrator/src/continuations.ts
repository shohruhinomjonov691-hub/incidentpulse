import type { ActionControls, ActionFlow } from "./action-flow.ts";
import type { IncidentGraph } from "./graph.ts";
import type { InvestigationPolicy } from "./investigation-policy.ts";
import { type ResumeRequest, resumeIncident } from "./run.ts";

export function createContinuations(options: {
  graph: IncidentGraph;
  controls: ActionControls;
  flow?: ActionFlow;
  policy?: InvestigationPolicy;
}) {
  const { graph, controls, flow, policy } = options;
  return {
    async resume(request: ResumeRequest) {
      if (await controls.isStopped()) return;
      const outcome = await resumeIncident(graph, request);
      if (
        outcome.state?.primary &&
        (outcome.state.reportSent || outcome.state.approval || outcome.state.workflowStatus)
      ) {
        await policy?.remember(outcome.state, request.incidentId.startsWith("manual-"));
      }
      if (request.approvalId && !outcome.approvalPending)
        await flow?.approvals.markResumed(request.approvalId);
      if (!outcome.paused) await controls.clearPaused(request.incidentId);
    },
    async tick(enqueue: (request: ResumeRequest) => Promise<void>) {
      await flow?.approvals.expire();
      await flow?.remind();
      if (await controls.isStopped()) return;
      for (const approval of (await flow?.approvals.pendingResumes()) ?? []) {
        await enqueue({ incidentId: approval.incidentId, approvalId: approval.id });
      }
      for (const incidentId of await controls.pausedIncidents()) await enqueue({ incidentId });
    },
  };
}
