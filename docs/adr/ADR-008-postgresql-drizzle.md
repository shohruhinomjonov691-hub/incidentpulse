# ADR-008: PostgreSQL for durable state (Drizzle not adopted)

- **Status:** Accepted with a deviation from the spec
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-008

## Context

Incidents, the event journal, approvals with their audit log and the LangGraph checkpoints must survive restarts, and approval tokens must be consumable exactly once.

## Decision

PostgreSQL holds the LangGraph checkpoints (`PostgresSaver`), the incident journal and timeline events, the approval store with single-use tokens and an append-only action audit, and postmortems. Access is plain `pg` with hand-written SQL in small modules.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `postgres:18.7-alpine`, `pg` 8.23.1

## Why this and not another

Postgres gives the transactions and `FOR UPDATE`/unique-constraint semantics that "single use" and "one execution claim" need.

## Alternatives considered

- **Drizzle ORM** (named in SPEC §2). Not adopted: the schema is a handful of tables, the queries are few and security-critical, and explicit SQL made the locking visible. It would still be a reasonable change if the schema grows.
- **SQLite.** No shared access between the worker and the web app.

## Consequences

No generated types for rows: each module validates what it reads. Migrations are idempotent `CREATE TABLE IF NOT EXISTS` statements run at start-up, which is enough for now and not a migration framework.
