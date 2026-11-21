# ADR-007: Langfuse + OpenTelemetry for observability

- **Status:** Accepted (implemented, not yet verified against a live Langfuse)
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-007

## Context

I want every graph node, LLM call and tool call of an incident in one trace, with tokens and dollars, without ever sending a secret and without making tracing a requirement.

## Decision

`packages/telemetry` starts Langfuse tracing **only when both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set**; otherwise it returns a no-op object (no OpenTelemetry code is even loaded, no network request is made). When on: one trace per incident (trace id derived from the incident id, so resumes join the same trace), a span per graph node, a generation per LLM call (model, tokens, computed cost) and a tool observation per MCP call. Everything is redacted and length-capped before export.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `@langfuse/otel`, `@langfuse/tracing`, `@langfuse/core` 6.1.1 and the OpenTelemetry peers pinned in `pnpm-workspace.yaml`

## Why this and not another

Langfuse's OTel exporter gives tokens, cost and a trace tree with little code, and OTel keeps the door open to other backends. A no-key default keeps CI and local runs at zero dependency on any SaaS.

## Alternatives considered

- **LangSmith.** Good, but tied to the LangChain ecosystem.
- **Plain OTel + Jaeger.** No LLM-specific views (tokens, cost, prompts).
- **Home-made logs.** Already exist (the journal), but no trace UI.

## Consequences

The unit tests prove the exporter against a local OTLP receiver (Basic auth, redaction, off-by-default). I have **not** seen the traces in a real Langfuse project because no keys exist yet. Cloud vs self-host (SPEC §15.3) is still open.
