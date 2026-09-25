import secrets  # noqa: I001
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import require_auth
from config import INGEST_TOKEN
from database import get_db
from models import (
    JST,
    Direction,
    IngestState,
    Method,
    Source,
    Status,
    Transaction,
    now_jst,
)
from schemas import UNCATEGORIZED

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

# 未処理件数を入れる行の主キー。1行しか使わないので固定値。
INGEST_STATE_ID = 1


def require_ingest_token(x_ingest_token: str | None = Header(default=None)) -> None:
    if x_ingest_token is None or not secrets.compare_digest(
        x_ingest_token, INGEST_TOKEN
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="取り込み用トークンが不正です",
        )


class EmailItem(BaseModel):
    occurred_at: datetime
    amount: int = Field(gt=0)
    merchant: str | None = Field(default=None, max_length=255)
    external_key: str = Field(min_length=1, max_length=255)

    @field_validator("occurred_at")
    @classmethod
    def _to_jst_naive(cls, value: datetime) -> datetime:
        """+09:00 付きで来ても JST の naive に揃える（DB は naive JST で統一）。"""
        if value.tzinfo is not None:
            value = value.astimezone(JST).replace(tzinfo=None)
        return value


class EmailIngestRequest(BaseModel):
    items: list[EmailItem]
    # 外貨建てなどで円換算できず、取り込めなかった件数。
    unprocessed: int = Field(default=0, ge=0)


class IngestResult(BaseModel):
    inserted: int
    skipped: int
    unprocessed: int


class IngestStatus(BaseModel):
    unprocessed: int
    reported_at: datetime | None


@router.post(
    "/email",
    response_model=IngestResult,
    dependencies=[Depends(require_ingest_token)],
)
def ingest_email(payload: EmailIngestRequest, db: Session = Depends(get_db)):
    inserted = 0
    skipped = 0
    for item in payload.items:
        row = Transaction(
            occurred_at=item.occurred_at,
            direction=Direction.expense,
            amount=item.amount,
            method=Method.credit_card,
            category=UNCATEGORIZED,
            merchant=item.merchant,
            external_key=item.external_key,
            source=Source.email,
            status=Status.needs_review,
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            # external_key が UNIQUE なので、同じメールの再送はここに来る。
            # その1件だけ巻き戻して次へ進む（全体は止めない）。
            db.rollback()
            skipped += 1
        else:
            inserted += 1

    _save_unprocessed(db, payload.unprocessed)

    return IngestResult(
        inserted=inserted, skipped=skipped, unprocessed=payload.unprocessed
    )


@router.get(
    "/status",
    response_model=IngestStatus,
    dependencies=[Depends(require_auth)],
)
def ingest_status(db: Session = Depends(get_db)):
    """アプリが「未処理 N 件」を表示するために読む。認証はアプリ側の方式。"""
    state = db.get(IngestState, INGEST_STATE_ID)
    if state is None:
        return IngestStatus(unprocessed=0, reported_at=None)
    return IngestStatus(unprocessed=state.unprocessed, reported_at=state.reported_at)


def _save_unprocessed(db: Session, unprocessed: int) -> None:
    """未処理件数を上書き保存する（履歴は持たず、最新の報告だけを保持）。"""
    state = db.get(IngestState, INGEST_STATE_ID)
    if state is None:
        state = IngestState(id=INGEST_STATE_ID, unprocessed=unprocessed)
        db.add(state)
    else:
        state.unprocessed = unprocessed
        # 件数が前回と同じでも「いつ報告されたか」は更新したいので明示的に入れる。
        state.reported_at = now_jst()
    db.commit()
