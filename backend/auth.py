import secrets  # noqa: I001
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from config import APP_PASSWORD, AUTH_TOKEN

router = APIRouter(prefix="/api/auth", tags=["auth"])

bearer_scheme = HTTPBearer(auto_error=False)

# --- ログイン失敗のレート制限（プロセス内メモリ。単一プロセス運用前提）---
_MAX_FAILS = 3
_WINDOW_SECONDS = 300
_failed_attempts: dict[str, list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # Caddy が末尾に本当の接続元を足すので、最後の要素を使う
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _check_not_locked(ip: str) -> None:
    now = time.monotonic()
    recent = [t for t in _failed_attempts[ip] if now - t < _WINDOW_SECONDS]
    _failed_attempts[ip] = recent
    if len(recent) >= _MAX_FAILS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="ログイン試行が多すぎます。5分ほど待ってから再度お試しください。",
        )


class LoginRequest(BaseModel):
    password: str


class LoginResponse(BaseModel):
    token: str


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request):
    ip = _client_ip(request)
    _check_not_locked(ip)
    if not secrets.compare_digest(payload.password, APP_PASSWORD):
        _failed_attempts[ip].append(time.monotonic())
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="パスワードが違います",
        )
    _failed_attempts.pop(ip, None)
    return LoginResponse(token=AUTH_TOKEN)


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, AUTH_TOKEN
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="認証が必要です",
            headers={"WWW-Authenticate": "Bearer"},
        )
