# ADR-004: Debate verifier framework: AutoGen vs Microsoft Agent Framework

- **Status:** **Proposed. Decision needed from the owner.** SPEC §2 and §15.2 allow either framework; this records the finding.
- **Date:** 2026-11-21
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-004

## Context

**Debate verifier**: Investigator vs Skeptic with a Judge, who scores the top hypothesis.

## Decision

Use the framework listed in SPEC §2 for this role. Pinned version(s) (verified 2026-11-21, see [docs/VERSIONS.md](../VERSIONS.md)):

- Proposed: `agent-framework-core` 1.26.0 (Microsoft Agent Framework, Python)

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

## Options

| Option | Pros | Cons |
|---|---|---|
| A. Microsoft Agent Framework (`agent-framework-core` 1.26.0) | Maintained, 1.x stable APIs, supports MCP, graph workflows suit a debate loop | Different API from AutoGen (a redesign, not a version bump); exact package split (`-core` vs meta package vs orchestrations) to be confirmed in Phase 3 |
| B. AG2 community fork (1.3.3) | Keeps the AutoGen-style conversation model | Community project, not Microsoft |
| C. Pin `autogen-agentchat` 0.7.5 | Matches the wording of SPEC §2 literally | Archived: no security fixes. Not recommended |

**Recommendation:** A. SPEC §2 already says "or its successor, Microsoft Agent Framework; pin whichever is current", so no SPEC change is required, but SPEC prose that says "AutoGen" (§2 table, §3, §4, §11, §13, §14) would read more accurately if updated. That is a proposal for the owner, not applied.
