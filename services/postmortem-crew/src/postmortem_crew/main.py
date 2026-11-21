import importlib.util
import json
import os
from hmac import compare_digest

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

SERVICE_NAME = "postmortem-crew"

app = FastAPI(title=SERVICE_NAME, version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME}


def authorize(request: Request) -> None:
    secret = os.getenv("POSTMORTEM_SHARED_SECRET", "")
    supplied = request.headers.get("authorization", "")
    if len(secret) < 32 or not compare_digest(supplied.encode(), f"Bearer {secret}".encode()):
        raise HTTPException(401, "Unauthorized")


@app.get("/ready")
def ready(request: Request) -> dict[str, str]:
    authorize(request)
    if not os.getenv("OPENAI_API_KEY") or importlib.util.find_spec("crewai") is None:
        raise HTTPException(503, "Crew unavailable")
    return {"status": "ready"}


@app.post("/postmortem")
async def postmortem(request: Request) -> dict:
    authorize(request)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 6_000:
            raise HTTPException(413, "Incident record too large")
    try:
        record = json.loads(body)
        if not isinstance(record, dict) or record.get("status") not in ("recovered", "escalated"):
            raise ValueError
        if not isinstance(record.get("costUsd"), int | float):
            raise ValueError
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(422, "A closed incident record is required") from exc
    from .crew import generate

    return await run_in_threadpool(generate, record)
