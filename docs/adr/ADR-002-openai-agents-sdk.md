# ADR-002: OpenAI Agents SDK (JS) for triage, handoffs and guardrails

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-002

## Context

Triage must hand a problem to the right specialist, specialists need tools, and everything an agent reads (logs, HTML, commit messages) is untrusted text that may try to steer it.

## Decision

`triage` is an Agents SDK `Agent` with native `handoffs` to the infra, logs and code specialists; each specialist is a small agent whose only tools come from its own MCP child process. Input guardrails strip or mark prompt-injection lines; output guardrails reject ungrounded hypotheses (a cited evidence id must exist) and any runbook outside the registry. Every model call goes through one wrapper (`limitModelSpend`) that books spend against the weekly budget.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `@openai/agents` 0.22.0

## Why this and not another

Handoffs and guardrails are built-in primitives, so triage "may not conclude" is structural (the handoff target records the decision and never calls an LLM), not a prompt request. Specialists stay small enough to test individually.

## Alternatives considered

- **LangGraph prebuilt agents.** Would work, but handoffs and guardrails would be re-implemented.
- **Vercel AI SDK agent loop.** Great for the UI (ADR-006); no handoff or guardrail concept.
- **Raw Responses API calls.** Maximum control, but I would have rebuilt the tool loop, MCP wiring and guardrails.

## Consequences

Tied to the OpenAI Responses API shape (the cost is computed from its usage object). Tracing to OpenAI's backend is disabled on purpose (`setTracingDisabled(true)`): incident data goes only to the model call, and observability goes to Langfuse (ADR-007).
