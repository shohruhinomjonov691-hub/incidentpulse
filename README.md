# IncidentPulse

Autonomous multi-agent incident investigator for 6 production apps. It detects, triages, investigates, debates, proposes a fix,
waits for human approval, executes, verifies recovery and writes a postmortem.

Full design: [docs/SPEC.md](docs/SPEC.md). Pinned versions: [docs/VERSIONS.md](docs/VERSIONS.md). Decisions: [docs/adr/](docs/adr/).

**Status: Phase 5.** Closed incidents get a CrewAI postmortem and a private web dashboard (live timeline, web Approve, evidence-only chat). Signal → change detection and cache → triage → parallel specialists → synthesis → optional debate → optional human-approved runbook → recovery check. Automatic investigations run on change or in a Sunday batch, with a shared $0.50 weekly LLM budget.

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
pnpm sandbox:eval --scenarios 1,3,12 --runs 1 --injection-mode strip  # manual paid eval, local sandbox only
pnpm sandbox:approvals                        # sandbox TLS and stopped-container repair with Telegram approval
```

## Layout

```
apps/       orchestrator, intake, web, telegram-bot      (TypeScript)
mcp/        infra, codetrail, actions                    (TypeScript MCP servers)
packages/   schemas, redact, config, telemetry           (TypeScript)
services/   debate-verifier, postmortem-crew             (Python 3.12, FastAPI)
sandbox/ + compose.sandbox.yaml  local fault-injection stack (scenarios 1-6, 12)
runbooks/ evals/ templates/                              (later phases)
```

`packages/schemas` is the TS ↔ Python contract: zod schemas generate JSON Schema, and both languages validate the same fixture.
