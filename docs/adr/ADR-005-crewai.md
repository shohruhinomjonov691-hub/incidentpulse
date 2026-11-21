# ADR-005: CrewAI for the postmortem crew

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-005

## Context

Each closed incident should get a short postmortem (summary, timeline, root cause, fix, prevention) that does not invent facts.

## Decision

`services/postmortem-crew` is a FastAPI service running a sequential CrewAI crew: Researcher (extracts a factual chronology and evidence ids from the incident record) → Reviewer (finds gaps, separates confirmed from inferred claims) → Writer (writes the markdown postmortem). The orchestrator calls it over HTTP with a shared secret and books the returned token usage against the weekly budget.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `crewai` 1.15.44 (Python 3.12, FastAPI service)

## Why this and not another

Role/task-based sequential crews map directly onto "research, check, write". The Reviewer step is what keeps "Confirmed" and "Hypothesis (not fully proven by the record)" separate in the output.

## Alternatives considered

- **One templated LLM call.** Cheaper and probably enough for a 2-3k character document; the crew is partly a deliberate framework choice (SPEC §2) and I say so.
- **Reuse Microsoft Agent Framework** (ADR-004). Would drop a dependency, at the cost of mixing two different jobs in one service.

## Consequences

A heavy dependency tree and a second Python service. Measured cost in the sandbox: about $0.004 per postmortem with a small model.
