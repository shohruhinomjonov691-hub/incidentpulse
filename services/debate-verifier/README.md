# debate-verifier

Debate verifier: Investigator vs Skeptic with a Judge scoring the top hypothesis.

**Status:** Phase 0 skeleton. Only `GET /health` exists; the real service starts in Phase 3
(see [docs/SPEC.md](../../docs/SPEC.md) §13, [ADR-004](../../docs/adr/)).

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/); FastAPI.
- The shared contract is `packages/schemas/json/incident-state.schema.json`
  (`tests/test_contract.py` validates a fixture against it).

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run uvicorn --app-dir src debate_verifier.main:app --host 127.0.0.1 --port 8000
```
