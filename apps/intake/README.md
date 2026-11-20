# @incidentpulse/intake

Fastify webhook receiver (SPEC §3, §10, §12). Verifies the HMAC + timestamp, validates the payload, and enqueues the incident in BullMQ with deduplication.

## Webhook contract (CodeTrail → intake)

`POST /webhook/monitor`, `Content-Type: application/json`, body `{project, check, level, summary, at}` (≤ 16 KiB):

```
X-IncidentPulse-Timestamp: <unix seconds>
X-IncidentPulse-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_HMAC_SECRET, "<timestamp>.<raw body>")>
```

| Response | Meaning |
|---|---|
| `202 {status:"queued", incidentId}` | accepted |
| `202 {status:"duplicate", incidentId}` | same `project:check` already queued inside `DEDUP_TTL_SECONDS` (default 600) |
| `202 {status:"ignored"}` | `level` is not `down` (recovery signals are ignored until Phase 4) |
| `401 {error:"unauthorized"}` | missing/invalid signature, or timestamp more than 5 minutes away from now (past or future) |
| `400` | invalid JSON / payload (field names only, never values) |

The timestamp is inside the MAC, so a captured request cannot be replayed after the window.

## Run

```bash
docker compose up -d                          # redis
pnpm --filter @incidentpulse/intake start     # reads ../../.env; binds 127.0.0.1:8787
pnpm incident:simulate --project kervan       # sends a correctly signed Down signal
```

Integration test against real Redis: `IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 pnpm --filter @incidentpulse/intake test`.
