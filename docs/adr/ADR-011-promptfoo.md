# ADR-011: Custom eval harness instead of promptfoo

- **Status:** Accepted with a deviation from the spec
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-011

## Context

The eval has to inject real faults into a Docker stack, wait for them to be live, run a multi-agent investigation (sometimes two at once), and score the category, the proposed runbook, safety, time, tokens and dollars, under a hard cost ceiling.

## Decision

`apps/orchestrator/scripts/sandbox-eval.ts` (run with `pnpm sandbox:eval`) drives `sandbox/scripts/sandbox.sh`, runs the real graph with an in-memory notifier, scores deterministically (label match, proposed runbook, canary/`rm -rf` leak check, code evidence cited) and writes `sandbox/results/*.json`, which the web `/evals` page renders. CI runs the same graph with mocked LLMs for $0.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): none (promptfoo 0.126.0 was pinned in the catalog but not adopted)

## Why this and not another

promptfoo evaluates prompts against fixed inputs; this eval's hard part is the stateful sandbox (inject, wait, observe, reset) and per-run cost, which a declarative config does not express well.

## Alternatives considered

- **promptfoo with a custom provider that calls the harness.** Feasible; I did not need its UI or matrix features for 14 scenarios.
- **LLM-as-judge for the cause text.** Skipped to save money: scoring is by label and deterministic checks, and the README says so.

## Consequences

No CI regression gate on live runs (they cost money, so they are manual). No judge for the free-text cause. Both are listed as limitations in the README.
