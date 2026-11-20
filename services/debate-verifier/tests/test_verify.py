from fastapi.testclient import TestClient

from debate_verifier.debate import DebateResult
from debate_verifier.main import app

SECRET = "a" * 32
HEADERS = {"authorization": f"Bearer {SECRET}"}
HYP = {"id": "h1", "cause": "expired leaf", "confidence": 0.7, "supportingEvidenceIds": []}


def test_verify_contract_and_usage_header(monkeypatch):
    monkeypatch.setenv("DEBATE_SHARED_SECRET", SECRET)

    async def debate(payload):
        assert payload["hypotheses"] == [HYP]
        return DebateResult(
            verdict={
                "hypothesisId": "h1",
                "confidence": 0.65,
                "dissent": "",
                "missing": ["certificate chain"],
            },
            cost_usd=0.001,
        )

    monkeypatch.setattr("debate_verifier.main.run_debate", debate)
    with TestClient(app) as client:
        response = client.post(
            "/verify", headers=HEADERS, json={"evidence": [], "hypotheses": [HYP]}
        )
        assert response.status_code == 200
        assert response.json()["missing"] == ["certificate chain"]
        assert float(response.headers["x-debate-cost-usd"]) == 0.001


def test_verify_rejects_invalid_auth_and_round_count(monkeypatch):
    monkeypatch.setenv("DEBATE_SHARED_SECRET", SECRET)
    with TestClient(app) as client:
        assert client.post("/verify", json={}).status_code == 401
        assert (
            client.post(
                "/verify",
                headers=HEADERS,
                json={
                    "evidence": [],
                    "hypotheses": [HYP],
                    "rounds": 3,
                },
            ).status_code
            == 422
        )


def test_skeptic_must_name_an_actual_evidence_item(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    import pytest

    from debate_verifier import debate

    roles = []

    class Client:
        def __init__(self, **_options):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    class MockAgent:
        def __init__(self, _client, *, name, instructions):
            self.name = name
            assert "evidence" in instructions

        async def run(self, _prompt, *, options):
            roles.append(self.name)
            assert options["max_tokens"] <= 420
            text = "The endpoint failed"
            if self.name == "Skeptic":
                text = '{"weakestEvidenceId":"made-up","critique":"unsupported"}'
            return SimpleNamespace(text=text, usage_details={})

    monkeypatch.setenv("OPENAI_API_KEY", "mock")
    monkeypatch.setattr(debate, "Agent", MockAgent)
    monkeypatch.setattr(debate, "AsyncOpenAI", Client)
    monkeypatch.setattr(debate, "OpenAIChatClient", lambda **_: object())
    with pytest.raises(ValueError, match="Skeptic did not name supplied evidence"):
        asyncio.run(
            debate.run_debate(
                {
                    "evidence": [
                        {"id": "i1", "source": "infra", "tool": "http", "excerpt": "timeout"}
                    ],
                    "hypotheses": [HYP],
                }
            )
        )
    assert roles == ["Investigator", "Skeptic"]
