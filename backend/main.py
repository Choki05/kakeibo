from fastapi import FastAPI

from routers import transactions

app = FastAPI(title="Kakeibo API")
app.include_router(transactions.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}