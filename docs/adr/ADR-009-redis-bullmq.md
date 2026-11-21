# ADR-009: Redis + BullMQ for intake, dedup and scheduling

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-009

## Context

Monitor webhooks arrive in bursts and repeat (Down, Down, Down). They must not spawn duplicate investigations, and a crash must not lose one.

## Decision

The intake API verifies the HMAC and enqueues a BullMQ job with a job id plus a 10-minute BullMQ deduplication key (per project and check) and retry/backoff. The worker applies the investigation policy (`on_change` or weekly, daily re-check, conclusion cache). Redis also holds the global kill-switch flag, the weekly budget counter and the cached conclusions.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `bullmq` 6.7.8, `ioredis` 5.11.1, `redis:8.8-alpine`

## Why this and not another

Retries, dedup by job id, repeatable schedulers and delayed jobs are the queue features this needs, and Redis is already required for the flags and counters.

## Alternatives considered

- **Postgres as a queue.** Possible, but retries/schedulers would be hand-built.
- **In-process timers.** Lose work on restart.

## Consequences

Redis must be password-protected and bound to loopback (compose does this). The weekly budget is an integer micro-USD counter reserved by a small atomic Lua script (check, then `INCRBY`), tested in `weekly-budget.test.ts`.
