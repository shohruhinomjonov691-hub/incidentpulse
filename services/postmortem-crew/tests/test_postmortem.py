from types import SimpleNamespace

from fastapi.testclient import TestClient

from postmortem_crew.main import app


def test_postmortem_requires_authorization_and_a_closed_incident(monkeypatch):
    secret = "test-secret-" * 4
    monkeypatch.setenv("POSTMORTEM_SHARED_SECRET", secret)
    client = TestClient(app)
    assert client.post("/postmortem", json={}).status_code == 401
    headers = {"authorization": f"Bearer {secret}"}
    response = client.post(
        "/postmortem", headers=headers, json={"status": "investigating", "costUsd": 0.01}
    )
    assert response.status_code == 422


def test_real_crew_uses_three_bounded_calls_and_reports_usage(monkeypatch):
    from postmortem_crew import crew

    prompts = []
    answers = iter(
        [
            "Evidence E1 confirms expired certificate.",
            "E1 is sufficient for the TLS failure but not for missed renewal.",
            "# Incident\n\n## Timeline\nRecovered.\n## Root cause\nExpired.\n"
            "## Fix\nRenewed.\n## Prevention\nMonitor expiry.\n## Cost\nPlaceholder.",
        ]
    )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.complete))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def complete(self, **kwargs):
            assert kwargs["max_completion_tokens"] == 900
            assert kwargs["store"] is False
            prompts.append(str(kwargs["messages"]))
            return SimpleNamespace(
                usage=SimpleNamespace(
                    prompt_tokens=100, completion_tokens=20, prompt_tokens_details=None
                ),
                choices=[SimpleNamespace(message=SimpleNamespace(content=next(answers)))],
            )

    monkeypatch.setattr(crew, "OpenAI", FakeOpenAI)
    result = crew.generate({"status": "recovered", "costUsd": 0.02, "evidence": ["E1"]})
    assert len(prompts) == 3
    assert "Researcher" in prompts[0] and "Reviewer" in prompts[1] and "Writer" in prompts[2]
    assert result["micro"] == 135
    assert "$0.000135" in result["markdown"]
