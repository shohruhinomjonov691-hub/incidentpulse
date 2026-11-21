// Optional Langfuse tracing over OpenTelemetry (SPEC §8, ADR-007).
//
// OFF BY DEFAULT: nothing is imported, started or sent unless BOTH LANGFUSE_PUBLIC_KEY and
// LANGFUSE_SECRET_KEY are set. With no keys, `startTelemetry` returns a no-op object: no OTel
// SDK is loaded, no timer runs and no network request is ever made.
//
// One incident = one Langfuse trace: the trace id is derived from the incident id, so graph nodes,
// LLM generations and tool calls of the same incident group together even after a restart/resume.
// Everything exported passes through `redact` first (secrets) and is length-capped.

export const PACKAGE_NAME = "@incidentpulse/telemetry";

export interface TelemetryEnv {
  LANGFUSE_PUBLIC_KEY?: string | undefined;
  LANGFUSE_SECRET_KEY?: string | undefined;
  LANGFUSE_BASE_URL?: string | undefined;
  /** Older name for the base URL. */
  LANGFUSE_HOST?: string | undefined;
  [key: string]: string | undefined;
}

/** True only when both keys are present and non-blank. */
export function langfuseEnabled(env: TelemetryEnv): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY?.trim() && env.LANGFUSE_SECRET_KEY?.trim());
}

/**
 * True when a configured base URL would send keys and incident data in cleartext: anything that is
 * not https and not loopback. Tracing then stays OFF rather than leaking over plain HTTP.
 */
export function insecureBaseUrl(env: TelemetryEnv): boolean {
  const raw = env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return true;
  }
}

export interface ObserveOptions {
  incidentId: string;
  name: string;
  project?: string | undefined;
  /** Langfuse observation type; graph nodes are plain spans. */
  type?: "span" | "agent" | "chain";
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface GenerationOptions {
  name: string;
  model: string;
  input?: unknown;
  output?: unknown;
  usage: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  startTime: Date;
  endTime: Date;
}

export interface ToolOptions {
  name: string;
  source?: string;
  input?: unknown;
  output?: unknown;
  blocked?: boolean;
  startTime: Date;
  endTime: Date;
}

export interface Telemetry {
  readonly enabled: boolean;
  /** Runs `fn` inside an observation that belongs to the incident's trace. Pass-through when off. */
  observe<T>(options: ObserveOptions, fn: () => Promise<T>): Promise<T>;
  /** Records an LLM call that already finished (a child of the active observation). */
  generation(options: GenerationOptions): void;
  /** Records a tool call that already finished (a child of the active observation). */
  tool(options: ToolOptions): void;
  /** Flushes and stops the exporter. Safe to call more than once. */
  shutdown(): Promise<void>;
}

export const noopTelemetry: Telemetry = {
  enabled: false,
  observe: (_options, fn) => fn(),
  generation: () => undefined,
  tool: () => undefined,
  shutdown: async () => undefined,
};

export interface StartTelemetryOptions {
  /** Removes secrets from every string before export. */
  redact?: (text: string) => string;
  /** Deployment label shown in Langfuse (e.g. "sandbox", "production"). */
  environment?: string;
  /** Test seams. */
  exportMode?: "immediate" | "batched";
  compression?: "gzip" | "none";
}

const MAX_TEXT = 4000;

function sanitize(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") {
    const clean = redact(value);
    return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
  }
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, redact, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([k, v]) => [k, sanitize(v, redact, depth + 1)]),
  );
}

/**
 * Starts Langfuse tracing when LANGFUSE_* keys are configured; otherwise returns `noopTelemetry`.
 * Never throws: a tracing problem must not take an incident investigation down.
 */
export async function startTelemetry(
  env: TelemetryEnv,
  options: StartTelemetryOptions = {},
): Promise<Telemetry> {
  if (!langfuseEnabled(env) || insecureBaseUrl(env)) return noopTelemetry;
  const redact = options.redact ?? ((text: string) => text);
  try {
    // Imported lazily so the "off" path never loads the OpenTelemetry SDK.
    const [{ LangfuseSpanProcessor }, tracing, { NodeTracerProvider }, { propagateAttributes }] =
      await Promise.all([
        import("@langfuse/otel"),
        import("@langfuse/tracing"),
        import("@opentelemetry/sdk-trace-node"),
        import("@langfuse/core"),
      ]);

    const processor = new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY?.trim() as string,
      secretKey: env.LANGFUSE_SECRET_KEY?.trim() as string,
      baseUrl: env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || undefined,
      mediaUploadEnabled: false,
      mask: ({ data }) => sanitize(data, redact),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.exportMode ? { exportMode: options.exportMode } : {}),
      ...(options.compression ? { compression: options.compression } : {}),
    });
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    // register() installs the async-context manager that makes "active observation" work across awaits.
    provider.register();
    tracing.setLangfuseTracerProvider(provider);

    const traceCache = new Map<string, Promise<string>>();
    const traceIdFor = (incidentId: string) => {
      let id = traceCache.get(incidentId);
      if (!id) {
        id = tracing.createTraceId(incidentId);
        traceCache.set(incidentId, id);
        if (traceCache.size > 500) traceCache.delete(traceCache.keys().next().value as string);
      }
      return id;
    };
    // A fixed, otherwise-unused span id: every top-level observation of one incident hangs under it.
    const ROOT_SPAN_ID = "0000000000000001";
    let closed = false;

    return {
      enabled: true,
      async observe(o, fn) {
        if (closed) return fn();
        // Once `fn` has run, its outcome is final: a tracing failure afterwards must not re-run it.
        let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
        const safely = (action: () => void) => {
          try {
            action();
          } catch {
            // never let tracing break the investigation
          }
        };
        try {
          const traceId = await traceIdFor(o.incidentId);
          const nested = tracing.getActiveTraceId() === traceId;
          await propagateAttributes(
            {
              traceName: "incident",
              sessionId: o.incidentId,
              tags: [...(o.project ? [`project:${o.project}`] : []), ...(o.tags ?? [])],
              metadata: { ...(o.project ? { project: o.project } : {}), ...o.metadata },
            },
            () =>
              tracing.startActiveObservation(
                o.name,
                async (observation) => {
                  safely(() => observation.update({ input: sanitize(o.input, redact) }));
                  try {
                    const value = await fn();
                    outcome = { ok: true, value };
                    safely(() =>
                      observation.update({ output: sanitize(summarize(value), redact) }),
                    );
                  } catch (error) {
                    outcome = { ok: false, error };
                    safely(() =>
                      observation.update({
                        level: "ERROR",
                        statusMessage: redact(
                          error instanceof Error ? error.message : String(error),
                        ).slice(0, 500),
                      }),
                    );
                  }
                },
                {
                  asType: o.type ?? "span",
                  ...(nested
                    ? {}
                    : { parentSpanContext: { traceId, spanId: ROOT_SPAN_ID, traceFlags: 1 } }),
                } as never,
              ),
          );
        } catch {
          // fall through: setup failed, or fn already settled
        }
        if (!outcome) return fn(); // tracing failed before `fn` started: run it untraced
        if (outcome.ok) return outcome.value as never;
        throw outcome.error;
      },
      generation(g) {
        if (closed) return;
        try {
          tracing
            .startObservation(
              g.name,
              {
                model: g.model,
                input: sanitize(g.input, redact),
                output: sanitize(g.output, redact),
                usageDetails: {
                  input: g.usage.inputTokens,
                  output: g.usage.outputTokens,
                  total: g.usage.inputTokens + g.usage.outputTokens,
                },
                ...(g.costUsd === undefined ? {} : { costDetails: { total: g.costUsd } }),
              },
              { asType: "generation", startTime: g.startTime },
            )
            .end(g.endTime);
        } catch {
          // never let tracing break the investigation
        }
      },
      tool(t) {
        if (closed) return;
        try {
          tracing
            .startObservation(
              t.name,
              {
                input: sanitize(t.input, redact),
                output: sanitize(t.output, redact),
                ...(t.blocked ? { level: "WARNING", statusMessage: "blocked by allowlist" } : {}),
                metadata: { ...(t.source ? { source: t.source } : {}) },
              } as never,
              { asType: "tool", startTime: t.startTime },
            )
            .end(t.endTime);
        } catch {
          // never let tracing break the investigation
        }
      },
      async shutdown() {
        if (closed) return;
        closed = true;
        try {
          await processor.forceFlush();
          await provider.shutdown();
        } catch {
          // best effort
        }
      },
    };
  } catch {
    return noopTelemetry;
  }
}

/** Observation output must stay small: keep only a shallow hint of what a node returned. */
function summarize(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  return Object.keys(result as Record<string, unknown>);
}
