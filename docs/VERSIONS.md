# Pinned versions

Verified on **2026-11-21** against the package registries (npm, PyPI, Docker Hub), GitHub, nodejs.org and
learn.microsoft.com. Exact pins everywhere; lockfiles (`pnpm-lock.yaml`, `services/*/uv.lock`) pin the transitive tree.
TypeScript pins live in the `catalog` / `catalogs.frameworks` sections of `pnpm-workspace.yaml`.

## Tooling

| Tool | Pin | Note |
|---|---|---|
| Node | 24 (`.nvmrc`, `engines`: `>=24 <25`) | See "Node 24 vs 26" below |
| pnpm | 12.21.0 (`packageManager`) | |
| Turborepo | 2.11.13 | |
| TypeScript | 7.0.2 | `tsc --noEmit` passes on all packages |
| Vitest | 5.1.1 | engines `^22.12 \|\| ^24 \|\| >=26`, so odd Node 25 is unsupported |
| zod | 4.6.7 | built-in `z.toJSONSchema()` replaces `zod-to-json-schema` |
| Biome | 2.6.8 | TS lint/format. **Not named in the spec**, chosen to keep CI "lint" to one dependency |
| Python | 3.12 (`.python-version`) | |
| uv | 0.13.9 (local) | |
| FastAPI / uvicorn | 0.165.0 / 0.54.0 | |
| pytest / ruff | 9.2.0 / 0.17.6 | |
| httpx2 | 2.16.2 | Starlette's TestClient now deprecates `httpx` in favour of `httpx2` |
| jsonschema | 4.26.0 | contract tests in the Python services |
| PostgreSQL / Redis | `postgres:18.7-alpine` / `redis:8.8-alpine` | 19.0 exists but is brand new; 18 chosen |

## Frameworks (adopted in later phases)

| ADR | Package | Pin |
|---|---|---|
| 001 | `@langchain/langgraph` / `-checkpoint-postgres` | 1.7.5 / 1.1.4 |
| 002 | `@openai/agents` | 0.22.0 |
| 003 | `@modelcontextprotocol/sdk` | 1.32.2 |
| 004 | `agent-framework-core` (**accepted** 2026-11-21) | 1.26.0 |
| 005 | `crewai` | 1.15.44 |
| 006 | `ai` / `next` | 7.0.178 / 16.4.6 |
| 007 | `@langfuse/client`, `tracing`, `otel` / Python `langfuse` | 6.1.1 / 5.2.0 |
| 008 | `drizzle-orm` | 0.45.4 |
| 009 | `bullmq` | 6.7.8 |
| 010 | `grammy` | 1.46.0 |
| 011 | `promptfoo` | 0.126.0 |
| — | `fastify` (intake, SPEC §3) | 5.12.8 |
| 001 | `@langchain/core` (peer of LangGraph) | 1.5.0 |
| 009 | `ioredis` (peer of BullMQ) | 5.11.1 |

The Python frameworks are declared as optional extras (`agents`, `crew`) so the lockfiles prove they resolve on Python 3.12,
but they are not installed by default.

## AutoGen status (SPEC §15.2)

**AutoGen is archived, not merely in maintenance mode.** `microsoft/autogen` has `archived: true` (last push 2026-11-12); its README says
no bug fixes, no security fixes, no support, and points to Microsoft Agent Framework (MAF) as the successor. Last release:
`python-v0.7.5` (2025-09-30). MAF 1.x is the current line (PyPI `agent-framework` 1.26.0, Production/Stable, Python 3.12 supported).
`ag2` is a community fork, not Microsoft. Owner decision (2026-11-21): Microsoft Agent Framework. Details: [ADR-004](adr/ADR-004-autogen-or-agent-framework.md).

## Node 24 vs 26

The spec (§11) and the owner's Phase 0 brief say Node 24, so Node 24 is used. As of 2026-11-21 Node 24 is in *Maintenance* LTS
(Active LTS ended 2026-10-20; EOL 2028-04-30) and Node 26 is the *Active* LTS (since 2026-10-28). Vitest 5.1.1 supports both.
No action needed now; worth revisiting before Phase 7.

## Assumptions made in the schemas package (not in the spec)

- `ProjectId` values: `gotrip | kervan | camera-studio | codetrail | findit | food-lens` (the spec only says `'kervan' | 'gotrip' | ...`).
- Timestamps (`at`) are validated as ISO-8601 strings (the spec says `string`).
- Objects are strict (unknown keys rejected).
- Resolved 2026-11-21: `Evidence` gained `id: string` (SPEC §3.1 updated); `Hypothesis.supportingEvidenceIds` references it.

## LLM pricing (Phase 1 cost accounting)

Default model `gpt-5.4-mini`: $0.75 / $4.50 per 1M input / output tokens, cached input $0.075 (standard tier). `gpt-5.4-nano` ($0.20 / $1.25) exists but its model page is marked Deprecated.
Source: https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/models/gpt-5.4-mini (checked 2026-11-21). `costUsd` is *computed* from token usage; it is not read from an invoice.

## pnpm 12 build scripts

`msgpackr-extract` (an optional native accelerator of BullMQ) is explicitly denied in `pnpm-workspace.yaml` (`allowBuilds`); the pure-JS fallback is used.
