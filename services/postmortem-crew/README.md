# postmortem-crew

Postmortem crew: Researcher -> Reviewer -> Writer.

**Status:** Phase 5. `POST /postmortem` takes a closed (`recovered` or `escalated`) incident record and
runs a Researcher -> Reviewer -> Writer CrewAI crew that writes markdown following
[templates/postmortem.md](../../templates/postmortem.md) (Timeline, Root cause, Fix, Prevention, Cost).

- Auth: `Authorization: Bearer $POSTMORTEM_SHARED_SECRET` (>= 32 chars). `GET /ready` reports whether the crew can run.
- Cost: `gpt-5.4-nano`, at most 3 model calls, `reasoning_effort=none`, 900 output tokens each; one postmortem
  costs about $0.004 (hard cap $0.01, enforced by the orchestrator's reservation).
- The orchestrator (`apps/orchestrator/src/postmortem.ts`) calls it once per closed incident, stores the markdown in
  Postgres and charges the weekly budget. If the service is down the incident still closes and the postmortem stays
  `pending`; it is retried when the service is ready.

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/); FastAPI.
- The shared contract is `packages/schemas/json/incident-state.schema.json`
  (`tests/test_contract.py` validates a fixture against it).

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run uvicorn --app-dir src postmortem_crew.main:app --host 127.0.0.1 --port 8000
```
