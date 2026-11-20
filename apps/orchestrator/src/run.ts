import type { IncidentJob } from "@incidentpulse/schemas";
import { Command } from "@langchain/langgraph";
import type { GraphState, IncidentGraph } from "./graph.ts";
import type { PrimaryEvidence } from "./primary-evidence.ts";

export interface RunOutcome {
  state: GraphState;
  mode: "completed" | "resumed" | "already_done" | "waiting";
}

export type ResumeRequest = { incidentId: string; approvalId?: string };

const configFor = (id: string) => ({ configurable: { thread_id: id }, recursionLimit: 60 });

function interrupts(snapshot: Awaited<ReturnType<IncidentGraph["getState"]>>) {
  return snapshot.tasks
    .flatMap((task) => task.interrupts)
    .map((item) => ({
      id: item.id,
      ...(item.value as { kind?: string; approvalId?: string }),
    }));
}

export async function runIncident(
  graph: IncidentGraph,
  job: IncidentJob,
  primary?: PrimaryEvidence,
): Promise<RunOutcome> {
  const config = configFor(job.incidentId);
  const snapshot = await graph.getState(config);
  const hasCheckpoint = Object.keys(snapshot.values ?? {}).length > 0;

  if (hasCheckpoint && interrupts(snapshot).length) {
    return { state: snapshot.values as GraphState, mode: "waiting" };
  }
  if (hasCheckpoint && snapshot.next.length === 0) {
    return { state: snapshot.values as GraphState, mode: "already_done" };
  }
  const state = await graph.invoke(
    hasCheckpoint
      ? null
      : {
          incidentId: job.incidentId,
          project: job.project,
          signal: job.signal,
          ...(primary ? { primary } : {}),
        },
    config,
  );
  const after = await graph.getState(config);
  return {
    state: state as GraphState,
    mode: interrupts(after).length ? "waiting" : hasCheckpoint ? "resumed" : "completed",
  };
}

export async function resumeIncident(graph: IncidentGraph, request: ResumeRequest) {
  const config = configFor(request.incidentId);
  const snapshot = await graph.getState(config);
  const pending = interrupts(snapshot);
  const matches = pending.filter((item) =>
    request.approvalId
      ? item.kind === "approval" && item.approvalId === request.approvalId
      : item.kind === "paused",
  );
  if (matches.length) {
    await graph.invoke(
      new Command({
        resume: Object.fromEntries(matches.map(({ id }) => [id, true])),
      }),
      config,
    );
  } else if (!pending.length && snapshot.next.length) {
    // A transient failure after consuming the interrupt leaves normal checkpointed work.
    await graph.invoke(null, config);
  }
  const after = await graph.getState(config);
  const remaining = interrupts(after);
  return {
    state: after.values as GraphState | undefined,
    paused: remaining.some((item) => item.kind === "paused"),
    approvalPending: remaining.some(
      (item) => item.kind === "approval" && item.approvalId === request.approvalId,
    ),
  };
}
