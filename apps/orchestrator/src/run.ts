import type { IncidentJob } from "@incidentpulse/schemas";
import type { GraphState, IncidentGraph } from "./graph.ts";
import type { PrimaryEvidence } from "./primary-evidence.ts";

export interface RunOutcome {
  state: GraphState;
  /** "completed": ran now. "resumed": continued from a checkpoint. "already_done": no-op. */
  mode: "completed" | "resumed" | "already_done";
}

/**
 * Runs one incident with thread_id = incidentId, so the Postgres checkpoint is keyed per incident.
 * Safe to call again for the same job (BullMQ retry, worker restart):
 *  - finished checkpoint  -> returns it without re-running (no duplicate Telegram message);
 *  - unfinished checkpoint -> resumes from the last completed node.
 */
export async function runIncident(
  graph: IncidentGraph,
  job: IncidentJob,
  primary?: PrimaryEvidence,
): Promise<RunOutcome> {
  const config = { configurable: { thread_id: job.incidentId } };
  const snapshot = await graph.getState(config);
  const hasCheckpoint = Object.keys(snapshot.values ?? {}).length > 0;

  if (hasCheckpoint && snapshot.next.length === 0) {
    return { state: snapshot.values as GraphState, mode: "already_done" };
  }
  if (hasCheckpoint) {
    return { state: (await graph.invoke(null, config)) as GraphState, mode: "resumed" };
  }
  const state = await graph.invoke(
    {
      incidentId: job.incidentId,
      project: job.project,
      signal: job.signal,
      ...(primary ? { primary } : {}),
    },
    config,
  );
  return { state: state as GraphState, mode: "completed" };
}
