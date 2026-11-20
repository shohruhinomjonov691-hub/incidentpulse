# @incidentpulse/orchestrator

Phase 1 incident graph (LangGraph.js, Postgres checkpointer) and BullMQ worker.

```
intake ──► infra_specialist ──► synthesize ──► report
   │              │
   └──────────────┴── a budget is spent ──► escalate  (Telegram: "inson ko'rigi kerak")
```

- **infra_specialist**: an Agents SDK `Agent` connected to `mcp/infra` over stdio. Evidence is built by code from the *validated* tool results (`src/evidence.ts`), so the model can cite evidence but not forge it. The MCP child process gets only its host allowlist in its environment, no API keys.
- **synthesize**: structured-output call; cited evidence ids are checked against real evidence, confidence is clamped.
- **report**: validates the state against the shared `IncidentState` schema, then sends the Uzbek read-only message (SPEC §6 layout, no buttons) via `@incidentpulse/telegram-bot`.
- **Budgets (SPEC §8)**: `costUsd` is computed from token usage × price (`packages/config`).
  - Per incident: `INCIDENT_BUDGET_USD` (default $0.50). Per day: `DAILY_BUDGET_USD` (default $3), counted across all incidents in Redis (`incidentpulse:budget:daily:<UTC date>`, integer micro-USD via atomic `INCRBY`, 48 h TTL). The day is the **UTC** day.
  - Before each LLM step the graph checks both. If today's budget is already spent, the incident goes straight to `escalate` with **no LLM call**; if a budget is spent after the specialist, `synthesize` is skipped and the incident escalates with the evidence collected so far. If `synthesize` is what crosses the limit, the report is still sent (the analysis is already paid for) with a budget warning.
  - Limits are checked *before* a step, so one step can overshoot (bounded by `maxTurns`). With the single worker the daily total can exceed the limit by at most one LLM step.
- **Durability**: `thread_id = incidentId`. A retried job resumes from the last checkpoint, and a finished incident is never re-sent.
- **Secrets**: read only from the environment; every log line and outgoing message goes through `packages/redact`.

```bash
pnpm --filter @incidentpulse/orchestrator start          # reads ../../.env
pnpm --filter @incidentpulse/orchestrator show <incidentId>   # print evidence + the report from the checkpoint
# integration tests need real Postgres + Redis (docker compose up -d):
IT_DATABASE_URL=postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse \
IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 pnpm --filter @incidentpulse/orchestrator test
```
