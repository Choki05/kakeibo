from pathlib import Path

import auth
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from routers import ingest, transactions

app = FastAPI(title="Kakeibo API")
app.include_router(auth.router)
app.include_router(transactions.router)
app.include_router(ingest.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
