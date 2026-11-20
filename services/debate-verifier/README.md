# Debate verifier

Python 3.12 and FastAPI. `POST /verify` uses Microsoft Agent Framework's Investigator, Skeptic and Judge with `gpt-5.4-nano`. The Skeptic must identify an actual supplied evidence ID when evidence exists. The Judge's verdict and the request are validated with generated JSON Schemas from `packages/schemas/json`.

The service accepts one or two rounds per request. The orchestrator asks for one round at a time, with at most two per incident. The response body is `{hypothesisId, confidence, dissent, missing}` and the `X-Debate-Cost-Usd` header contains the token-usage estimate. Each agent uses at most 420 output tokens.

```bash
uv sync --locked
uv run pytest
uv run uvicorn debate_verifier.main:app --app-dir src --host 127.0.0.1 --port 8790
```

Set `OPENAI_API_KEY` in the service environment. Set the same `DEBATE_SHARED_SECRET` on both services. The orchestrator sends the secret as a bearer token and reserves weekly budget before making the request. Use a private endpoint and TLS across hosts.
