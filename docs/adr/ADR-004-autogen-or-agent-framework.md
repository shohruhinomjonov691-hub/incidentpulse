# ADR-004: Microsoft Agent Framework for the debate verifier (instead of AutoGen)

- **Status:** **Accepted** (owner decision, 2026-11-21): Microsoft Agent Framework, package `agent-framework-core`.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-004

## Context

**Debate verifier**: Investigator vs Skeptic with a Judge, who scores the top hypothesis.

## Decision

Use **Microsoft Agent Framework** (Python) for the debate verifier (Investigator vs Skeptic, Judge). AutoGen is not used: its repository is archived. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- `agent-framework-core` 1.26.0 (declared as the optional `agents` extra of `services/debate-verifier`; the exact package split is confirmed when Phase 3 starts)

## Why this and not another

Multi-agent conversation/debate is its core pattern; it reduces confident-but-wrong RCAs.

## Alternatives considered

TODO (fill in when the phase starts). Starting points: See the status finding below.

## Consequences

TODO.

## Status finding (verified 2026-11-21)

- `microsoft/autogen` is **archived**: GitHub `archived: true`, last push 2026-11-12. Its README says Microsoft provides *no bug fixes, security fixes, new features or support*, and advises against production use. The last release is `python-v0.7.5` (2025-09-30).
- Its README names **Microsoft Agent Framework** (`microsoft/agent-framework`) as the enterprise-ready successor. PyPI `agent-framework` / `agent-framework-core` are at 1.26.0, classified *Production/Stable*, and list Python 3.12 support. Microsoft's overview page calls it the "direct successor" of AutoGen and Semantic Kernel.
- `ag2` (1.3.3) is a separate community fork by AutoGen's original authors. It is not a Microsoft product.

Sources: https://github.com/microsoft/autogen · https://github.com/microsoft/agent-framework · https://learn.microsoft.com/en-us/agent-framework/overview/ · https://pypi.org/project/agent-framework-core/

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Microsoft Agent Framework (`agent-framework-core` 1.26.0) | Maintained, 1.x stable APIs, supports MCP, graph workflows suit a debate loop | Different API from AutoGen (a redesign, not a version bump); exact package split (`-core` vs meta package vs orchestrations) to be confirmed in Phase 3 |
| B. AG2 community fork (1.3.3) | Keeps the AutoGen-style conversation model | Community project, not Microsoft |
| C. Pin `autogen-agentchat` 0.7.5 | Matches the wording of SPEC §2 literally | Archived: no security fixes. Not recommended |

**Decision:** A. SPEC §2 was updated to match. Other SPEC sections (§3, §4, §11, §13, §14, §15.2) still say "AutoGen" in prose and diagrams; they are historical wording and are not changed unless the owner asks.
