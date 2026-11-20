# ADR-003: Model Context Protocol (TS SDK) for all tools

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-003

## Context

All tools are exposed via 3 MCP servers (infra / codetrail / actions).

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `@modelcontextprotocol/sdk` 1.32.2

## Why this and not another

Tools become reusable by any client (Claude, Cursor, Agents SDK), and the permission boundary sits at the process level.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: In-process function tools only.

## Consequences

TODO.
