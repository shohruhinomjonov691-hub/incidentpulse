# ADR-008: PostgreSQL + Drizzle ORM for durable state

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-008

## Context

Incidents, evidence, approvals, LangGraph checkpoints (PostgresSaver), eval runs.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- PostgreSQL 18 (`postgres:18.7-alpine` in compose.yaml)
- `drizzle-orm` 0.45.4

## Why this and not another

Durable checkpointer; relational audit log.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: SQLite; Prisma.

## Consequences

TODO.
