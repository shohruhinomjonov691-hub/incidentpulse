# ADR-006: Vercel AI SDK + Next.js for the live UI

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-006

## Context

Live incident timeline streaming, chat with an incident ("why did you conclude X?"), approval UI.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `ai` 7.0.178
- `next` 16.4.6

## Why this and not another

Streaming UI primitives; the same tool-call events render as a live timeline.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: Plain SSE + React; assistant-ui.

## Consequences

TODO.
