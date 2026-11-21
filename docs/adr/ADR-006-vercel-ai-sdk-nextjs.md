# ADR-006: Vercel AI SDK + Next.js for the live UI

- **Status:** Accepted (narrower use than the spec)
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-006

## Context

A person needs to watch an incident as it happens, ask "why did you conclude X?" and press Approve from a phone.

## Decision

`apps/web` is a Next.js app behind a single admin password (signed httpOnly cookie, rate-limited). The incident timeline is a server-sent-events stream over the Postgres event journal. "Ask this incident" uses the AI SDK `streamText` with that one incident's evidence only. Approve/Reject use the same signed token as the Telegram buttons.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `ai` 7.0.178, `@ai-sdk/openai` 4.0.122, `next` 16.4.6

## Why this and not another

Next.js gives server components, route handlers and SSE in one place. The AI SDK's `streamText` is the small, well-tested part for the chat.

## Alternatives considered

- **Plain React + Express.** More glue for the same result.
- **Telegram only.** Fine for alerts; poor for reading a 15-step timeline.

## Consequences

Honest note: the live timeline is plain SSE over the journal, not AI-SDK streaming. The AI SDK is used for the chat only. The page works at 375 px and in dark mode (screenshots in `docs/screenshots/`).
