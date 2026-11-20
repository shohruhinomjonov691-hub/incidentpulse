# ADR-009: Redis + BullMQ for the intake queue

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-009

## Context

Incident intake queue, dedup, retries, per-project concurrency = 1.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- Redis 8.8 (`redis:8.8-alpine` in compose.yaml)
- `bullmq` 6.7.8

## Why this and not another

Webhook bursts must not spawn duplicate investigations.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: Postgres-backed queue (pg-boss); in-memory queue.

## Consequences

TODO.
