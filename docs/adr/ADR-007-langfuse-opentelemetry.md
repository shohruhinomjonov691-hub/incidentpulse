# ADR-007: Langfuse + OpenTelemetry for observability

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-007

## Context

Trace every node, agent, tool call, token and $ cost.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `@langfuse/client`, `@langfuse/tracing`, `@langfuse/otel` 6.1.1 (TS)
- `langfuse` 5.2.0 (Python)

## Why this and not another

Agent observability and eval scoring in one place.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: Cloud vs self-host is still open (SPEC §15.3).

## Consequences

TODO.
