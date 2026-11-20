# IncidentPulse

Autonomous multi-agent incident investigator for 6 production apps. It detects, triages, investigates, debates, proposes a fix,
waits for human approval, executes, verifies recovery and writes a postmortem.

Full design: [docs/SPEC.md](docs/SPEC.md). Pinned versions: [docs/VERSIONS.md](docs/VERSIONS.md). Decisions: [docs/adr/](docs/adr/).

**Status: Phase 0 (skeleton).** Packages are empty shells with a smoke test. Real functionality starts in Phase 1.

## Prerequisites

- Node 24 (`nvm use`) and pnpm 12 (`corepack enable`)
- Python 3.12 via [uv](https://docs.astral.sh/uv/) (uv installs it for you)
- Docker (only for the local Postgres/Redis)

## Commands

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test      # TypeScript packages
pnpm generate                                  # regenerate packages/schemas/json from zod

cd services/debate-verifier && uv sync && uv run pytest     # likewise for services/postmortem-crew

docker compose up -d                           # postgres + redis on 127.0.0.1 only
```

## Layout

```
apps/       orchestrator, intake, web, telegram-bot      (TypeScript)
mcp/        infra, codetrail, actions                    (TypeScript MCP servers)
packages/   schemas, redact, config, telemetry           (TypeScript)
services/   debate-verifier, postmortem-crew             (Python 3.12, FastAPI)
runbooks/ sandbox/ evals/ templates/                     (later phases)
```

`packages/schemas` is the TS ↔ Python contract: zod schemas generate JSON Schema, and both languages validate the same fixture.
