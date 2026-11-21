import type { GraphState } from "./graph.ts";
import type { createPrimaryProbe } from "./primary-evidence.ts";

export function createRecoveryCheck(probe: ReturnType<typeof createPrimaryProbe>) {
  return async (state: GraphState) => {
    let check = state.signal.check;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const signal = await probe({
          incidentId: state.incidentId,
          project: state.project,
          signal: state.signal,
          dedupKey: `${state.project}:recovery`,
          receivedAt: new Date().toISOString(),
        });
        const health = signal.health;
        if (health) {
          const container =
            state.remediation?.runbookId === "docker_restart"
              ? state.remediation.params.service
              : state.remediation?.runbookId === "pm2_restart" && state.remediation.params.app
                ? `pm2:${state.remediation.params.app}`
                : undefined;
          const httpOk =
            health.endpoints.length > 0 && health.endpoints.every((target) => target.ok);
          const containerOk = Boolean(container && health.containers[container]);
          check = health.endpoints.map((endpoint) => endpoint.url).join(", ") || container || check;
          const ok = health.endpoints.length ? httpOk && (!container || containerOk) : containerOk;
          if (ok) return { ok, check };
        }
      } catch {
        // Probe transport failure cannot be treated as a verified recovery.
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { ok: false, check };
  };
}
