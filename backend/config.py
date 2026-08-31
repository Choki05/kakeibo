import os  # noqa: I001
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _require(key: str) -> str:
    value = os.getenv(key)
    if not value:
        raise RuntimeError(
            f"環境変数 {key} が設定されていません。"
            f"{BASE_DIR / '.env'} に {key}=... を追加してください。"
        )
    return value


APP_PASSWORD = _require("APP_PASSWORD")
AUTH_TOKEN = _require("AUTH_TOKEN")
INGEST_TOKEN = _require("INGEST_TOKEN")