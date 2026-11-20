# ADR-001: LangGraph.js as the incident state machine

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-001

## Context

Top-level incident state machine: cycles (investigate → verify → re-investigate), parallel fan-out, `interrupt()` for human approval, durable checkpoints.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `@langchain/langgraph` 1.7.5
- `@langchain/langgraph-checkpoint-postgres` 1.1.4

## Why this and not another

Only option here with first-class cycles + durable human-in-the-loop pauses that survive restarts.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: Hand-rolled state machine; Temporal; OpenAI Agents SDK alone (no durable interrupts).

## Consequences

TODO.
