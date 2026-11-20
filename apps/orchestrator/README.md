# @incidentpulse/orchestrator

Phase 1 incident graph (LangGraph.js, Postgres checkpointer) and BullMQ worker.

```
intake → infra_specialist → synthesize → report
              │                  │
   OpenAI Agents SDK agent   structured output (zod)
   + mcp-infra tools (stdio)       │
              └── budget ≥ $0.50 ──┴──► report (skips remaining LLM calls)
```

- **infra_specialist**: an Agents SDK `Agent` connected to `mcp/infra` over stdio. Evidence is built by code from the *validated* tool results (`src/evidence.ts`), so the model can cite evidence but not forge it. The MCP child process gets only its host allowlist in its environment, no API keys.
- **synthesize**: structured-output call; cited evidence ids are checked against real evidence, confidence is clamped.
- **report**: validates the state against the shared `IncidentState` schema, then sends the Uzbek read-only message (SPEC §6 layout, no buttons) via `@incidentpulse/telegram-bot`.
- **Cost**: `costUsd` is computed from token usage × price (`packages/config`); the incident stops spending at `INCIDENT_BUDGET_USD` (default $0.50).
- **Durability**: `thread_id = incidentId`. A retried job resumes from the last checkpoint, and a finished incident is never re-sent.
- **Secrets**: read only from the environment; every log line and outgoing message goes through `packages/redact`.

```bash
pnpm --filter @incidentpulse/orchestrator start          # reads ../../.env
pnpm --filter @incidentpulse/orchestrator show <incidentId>   # print evidence + the report from the checkpoint
# integration tests need real Postgres + Redis (docker compose up -d):
IT_DATABASE_URL=postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse \
IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 pnpm --filter @incidentpulse/orchestrator test
```
