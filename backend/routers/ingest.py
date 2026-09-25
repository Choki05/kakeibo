import secrets  # noqa: I001
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import require_auth
from config import INGEST_TOKEN
from database import get_db
from models import (
    JST,
    Direction,
    IngestState,
    IngestUnprocessed,
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


class UnprocessedItem(BaseModel):
    """円換算できず取り込めなかった1件。key は再実行しても変わらない識別子。"""

    key: str = Field(min_length=1, max_length=255)
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def _to_jst_naive(cls, value: datetime) -> datetime:
        if value.tzinfo is not None:
            value = value.astimezone(JST).replace(tzinfo=None)
        return value


class EmailIngestRequest(BaseModel):
    items: list[EmailItem]
    # GAS は過去7日分の未処理を毎回まるごと送る。サーバ側で控えと突き合わせ、
    # 「まだ対応済みにしていないもの」だけを数える。
    unprocessed: list[UnprocessedItem] = Field(default_factory=list)


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
            # 利用先はメモにも入れる。画面に出るのはメモなので、ユーザーが
            # 書き換えたり消したりできる。merchant 側はメール由来の元データとして残す。
            memo=item.merchant,
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

    unprocessed = _sync_unprocessed(db, payload.unprocessed)

    return IngestResult(inserted=inserted, skipped=skipped, unprocessed=unprocessed)


@router.get(
    "/status",
    response_model=IngestStatus,
    dependencies=[Depends(require_auth)],
)
def ingest_status(db: Session = Depends(get_db)):
    """アプリが「未処理 N 件」を表示するために読む。認証はアプリ側の方式。"""
    state = db.get(IngestState, INGEST_STATE_ID)
    return IngestStatus(
        unprocessed=_count_unprocessed(db),
        reported_at=state.reported_at if state else None,
    )


@router.post(
    "/dismiss",
    response_model=IngestStatus,
    dependencies=[Depends(require_auth)],
)
def dismiss_unprocessed(db: Session = Depends(get_db)):
    """未処理のお知らせを「対応済み」にする（手入力を終えたとき）。

    対応済みにするのは**いまサーバが知っている分だけ**。あとから届いたメールは
    別のキーで報告されるので、きちんと通知される。
    """
    for row in db.scalars(select(IngestUnprocessed)):
        row.dismissed = True

    state = _get_or_create_state(db)
    state.unprocessed = 0
    db.commit()

    return IngestStatus(unprocessed=0, reported_at=state.reported_at)


def _get_or_create_state(db: Session) -> IngestState:
    state = db.get(IngestState, INGEST_STATE_ID)
    if state is None:
        state = IngestState(id=INGEST_STATE_ID, unprocessed=0)
        db.add(state)
        db.flush()
    return state


def _count_unprocessed(db: Session) -> int:
    """まだ対応済みにしていない未処理の件数。"""
    return db.scalar(
        select(func.count())
        .select_from(IngestUnprocessed)
        .where(IngestUnprocessed.dismissed.is_(False))
    )


def _sync_unprocessed(db: Session, reported: list[UnprocessedItem]) -> int:
    """GAS の報告内容を控えと同期し、未対応の件数を返す。

    - すでにある行は dismissed（対応済みフラグ）を保ったまま報告時刻だけ更新
    - 初めて見るキーは未対応として追加
    - 報告に含まれなくなった行は削除（GAS の検索範囲=過去7日から外れたもの）
    """
    now = now_jst()
    reported_keys = {item.key for item in reported}

    existing = {row.key: row for row in db.scalars(select(IngestUnprocessed))}

    for key, row in existing.items():
        if key not in reported_keys:
            db.delete(row)

    for item in reported:
        row = existing.get(item.key)
        if row is None:
            db.add(
                IngestUnprocessed(
                    key=item.key,
                    occurred_at=item.occurred_at,
                    dismissed=False,
                    reported_at=now,
                )
            )
        else:
            row.occurred_at = item.occurred_at
            row.reported_at = now

    db.flush()

    unprocessed = _count_unprocessed(db)
    state = _get_or_create_state(db)
    state.unprocessed = unprocessed
    # 件数が前回と同じでも「いつ報告されたか」は更新したいので明示的に入れる。
    state.reported_at = now
    db.commit()
    return unprocessed
