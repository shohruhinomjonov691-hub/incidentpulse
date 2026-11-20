from fastapi.testclient import TestClient

from postmortem_crew.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "postmortem-crew"}
