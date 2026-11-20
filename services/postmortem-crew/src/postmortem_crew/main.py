from fastapi import FastAPI

SERVICE_NAME = "postmortem-crew"

app = FastAPI(title=SERVICE_NAME, version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME}
