# evals/

The eval harness is not promptfoo ([ADR-011](../docs/adr/ADR-011-promptfoo.md)). It lives in
`apps/orchestrator/scripts/sandbox-eval.ts` (`pnpm sandbox:eval`), drives the sandbox in [`sandbox/`](../sandbox/README.md) and writes
`sandbox/results/*.json`, which the web `/evals` page renders. Phase 6 results: [sandbox/README.md](../sandbox/README.md#phase-6-all-14-scenarios-one-run-each).

CI does not run live evals (they cost money); it runs the same graph with mocked LLMs for $0.
