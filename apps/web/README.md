# @incidentpulse/web

Next.js 16 + Vercel AI SDK dashboard (English UI, light/dark, usable at 375 px).

- Single admin: `WEB_ADMIN_PASSWORD` (>= 16 chars), httpOnly signed session cookie, 8 attempts / 15 min rate limit. Every page and API route is protected.
- `/incidents`: project, category, status, duration, AI cost.
- `/incidents/[id]`: live timeline over SSE (events are stored in Postgres: node start/end, redacted tool calls, hypotheses, debate, verdict, approval, execution, recovery). Approve/Reject use the same signed token mechanism as Telegram.
- "Ask this incident": `streamText`, evidence of that incident only, at most 10 questions per incident, charged to the weekly $0.50 budget.
- `/evals`: tables from `sandbox/results/*.json`. `/postmortems/[id]`: rendered markdown.

Env: `DATABASE_URL`, `REDIS_URL`, `WEB_ADMIN_PASSWORD`, `WEB_ORIGIN`, `CALLBACK_HMAC_SECRET` (never `APPROVAL_HMAC_SECRET`: the web UI cannot sign execution tokens), `OPENAI_API_KEY`.

```bash
pnpm --filter @incidentpulse/web test     # unit
IT_DATABASE_URL=... IT_REDIS_URL=... pnpm --filter @incidentpulse/web smoke   # Playwright: login, list, live timeline
pnpm sandbox:phase5 [--auto]              # sandbox scenario 1 end to end (real LLM, about $0.015)
```
