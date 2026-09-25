import enum  # noqa: I001
from datetime import datetime, timedelta, timezone

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy import Enum as SqlEnum
from sqlalchemy.orm import Mapped, mapped_column

from database import Base

JST = timezone(timedelta(hours=9))


def now_jst() -> datetime:
    """JST の現在時刻を、タイムゾーン情報なし（naive）で返す。"""
    return datetime.now(JST).replace(tzinfo=None)

class Direction(str, enum.Enum):
    expense = "expense"
    income = "income"

class Method(str, enum.Enum):
    credit_card = "credit_card"
    paypay = "paypay"
    cash = "cash"
    points = "points"
    bank_transfer = "bank_transfer"


class Source(str, enum.Enum):
    email = "email"
    manual = "manual"


class Status(str, enum.Enum):
    confirmed = "confirmed"
    needs_review = "needs_review"


class IngestState(Base):
    """メール取り込みの状態を保持する。行は id=1 の1件だけ使う。

    GAS が「円換算できず取り込めなかった件数」を報告してくる。
    アプリ側はこれを読んで「未処理 N 件」と表示する。
    """

    __tablename__ = "ingest_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    unprocessed: Mapped[int] = mapped_column(default=0)
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=now_jst)


class IngestUnprocessed(Base):
    """円換算できず取り込めなかったメールの控え。

    GAS は過去7日分を毎回まるごと報告してくる。その中身をここに同期し、
    「どれを手入力で片付けたか」を dismissed で覚える。
    時刻の大小で判定すると、対応済みにした直後に届いたメールを取りこぼすため、
    1件ごとのキーで管理する。
    """

    __tablename__ = "ingest_unprocessed"

    # GAS が作る安定した識別子（external_key と同じ作り方のハッシュ）
    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    dismissed: Mapped[bool] = mapped_column(default=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=now_jst)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_transactions_amount_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    direction: Mapped[Direction] = mapped_column(SqlEnum(Direction, native_enum=False))
    amount: Mapped[int]
    method: Mapped[Method] = mapped_column(SqlEnum(Method, native_enum=False))
    source: Mapped[Source] = mapped_column(
        SqlEnum(Source, native_enum=False), default=Source.manual
    )
    status: Mapped[Status] = mapped_column(
        SqlEnum(Status, native_enum=False), default=Status.confirmed
    )
    category: Mapped[str] = mapped_column(String(50))
    memo: Mapped[str | None] = mapped_column(String(255))
    merchant: Mapped[str | None] = mapped_column(String(255))
    external_key: Mapped[str | None] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now_jst)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=now_jst, onupdate=now_jst
    )