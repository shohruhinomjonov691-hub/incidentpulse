import asyncio
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from jsonschema import Draft202012Validator

from .debate import run_debate

SERVICE_NAME = "debate-verifier"
SCHEMAS_DIR = Path(__file__).resolve().parents[4] / "packages" / "schemas" / "json"


def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((SCHEMAS_DIR / f"{name}.schema.json").read_text()))


app = FastAPI(title=SERVICE_NAME, version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME}


@app.post("/verify")
async def verify(request: Request, response: Response) -> dict:
    key = os.environ.get("DEBATE_SHARED_SECRET", "")
    supplied = request.headers.get("Authorization", "")
    if len(key) < 32:
        raise HTTPException(status_code=503, detail="Debate service is unconfigured")
    if not hmac.compare_digest(f"Bearer {key}".encode(), supplied.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16_384:
            raise HTTPException(status_code=413, detail="Body is too large")
    try:
        payload = json.loads(body)
    except ValueError as err:
        raise HTTPException(status_code=422, detail="Invalid JSON") from err
    if not validator("debate-request").is_valid(payload):
        raise HTTPException(status_code=422, detail="Invalid debate input")
    if any(len(item["id"]) > 32 for item in [*payload["evidence"], *payload["hypotheses"]]):
        raise HTTPException(status_code=422, detail="Invalid evidence or hypothesis ID")

    try:
        async with asyncio.timeout(28):
            result = await run_debate(payload)
        if not validator("debate-verdict").is_valid(result.verdict) or not any(
            item["id"] == result.verdict["hypothesisId"] for item in payload["hypotheses"]
        ):
            raise ValueError("Judge returned an invalid verdict")
    except TimeoutError as err:
        raise HTTPException(status_code=504, detail="Debate timed out") from err
    except Exception as err:
        raise HTTPException(status_code=502, detail="Debate result unavailable") from err

    response.headers["X-Debate-Cost-Usd"] = f"{result.cost_usd:.9f}"
    return result.verdict
