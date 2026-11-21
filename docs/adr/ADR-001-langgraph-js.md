# ADR-001: LangGraph.js as the incident state machine

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-001

## Context

An incident is a long-lived workflow with cycles (verify → re-investigate, propose → execute → verify recovery → propose again), a parallel fan-out (one run per specialist) and a pause that can last an hour (waiting for a human). It must survive a process restart in the middle of the wait.

## Decision

The whole incident is one LangGraph.js `StateGraph` (`apps/orchestrator/src/graph.ts`): `intake → triage → investigate (Send fan-out) → join → synthesize → verify → propose → request_approval → await_approval (interrupt) → execute → verify_recovery → close`, plus `report`, `transient` and `escalate` exits. State is checkpointed in Postgres (`PostgresSaver`), and a Telegram/web approval resumes the same thread.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `@langchain/langgraph` 1.7.5, `@langchain/langgraph-checkpoint-postgres` 1.1.4, `@langchain/core` 1.5.0

## Why this and not another

It is the one option I evaluated with first-class cycles, `Send` fan-out and a durable `interrupt()` in the same abstraction. Each node stays a small function that is unit-tested with scripted fakes (no LLM), which is how CI runs the graph for $0.

## Alternatives considered

- **Plain async code + a `status` column.** Simplest, but resume-after-restart, fan-out ordering and the approval pause would all be hand-written.
- **Temporal / BullMQ flows.** Strong durability, but a second runtime to operate for a one-person VPS.
- **LangGraph Python.** Would have put the core in Python; I kept the core, MCP servers and UI in one TypeScript toolchain and used Python only where the framework demanded it (ADR-004, ADR-005).

## Consequences

Graph state must stay serialisable (evidence is stored as redacted excerpts plus a hash, never raw tool output). A new node needs a checkpoint-compatible state shape. The framework moves fast, so the version is pinned exactly.
