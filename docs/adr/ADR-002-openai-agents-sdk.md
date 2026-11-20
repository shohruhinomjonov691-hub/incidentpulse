# ADR-002: OpenAI Agents SDK (JS) for triage, handoffs and guardrails

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-002

## Context

Triage agent + **handoffs** to specialist agents; tool calling; input/output **guardrails**.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `@openai/agents` 0.22.0 (pre-1.0: expect breaking changes between minors)

## Why this and not another

Handoffs and guardrails are native primitives; specialists stay small and testable.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: LangGraph agents only; Vercel AI SDK agents; Claude Agent SDK.

## Consequences

TODO.
