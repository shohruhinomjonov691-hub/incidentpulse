# ADR-005: CrewAI for the postmortem crew

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-005

## Context

**Postmortem crew**: Researcher → Reviewer → Writer.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `crewai` 1.15.44 (requires Python >=3.10,<3.14, so the service stays on 3.12)

## Why this and not another

Role/task-based sequential crews fit document production well.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: A plain LLM chain with a template; Microsoft Agent Framework sequential workflow.

## Consequences

TODO.
