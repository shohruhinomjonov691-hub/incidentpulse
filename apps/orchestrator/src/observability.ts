import { noopTelemetry, type Telemetry } from "@incidentpulse/telemetry";

/**
 * The active tracer. A no-op until `startRuntime` (or the eval harness) installs a real Langfuse
 * one, which only happens when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set.
 */
let current: Telemetry = noopTelemetry;

export function setTelemetry(telemetry: Telemetry): void {
  current = telemetry;
}

export function telemetry(): Telemetry {
  return current;
}
