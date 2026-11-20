# ADR-011: promptfoo + custom harness for evals

- **Status:** Proposed (stub). Fill in at the start of the phase that adopts it.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-011

## Context

Eval runner, LLM-as-judge, CI regression gate.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `promptfoo` 0.126.0 (pre-1.0)

## Why this and not another

Declarative eval configs, works in GitHub Actions.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: Langfuse experiments; a fully custom runner.

## Consequences

TODO.
