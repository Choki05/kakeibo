from fastapi import FastAPI

import auth
from routers import transactions

app = FastAPI(title="Kakeibo API")
app.include_router(auth.router)
app.include_router(transactions.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}