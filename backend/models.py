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

class Direction(enum.StrEnum):
    expense = "expense"
    income = "income"

class Method(enum.StrEnum):
    credit_card = "credit_card"
    paypay = "paypay"
    cash = "cash"
    points = "points"
    bank_transfer = "bank_transfer"


class Source(enum.StrEnum):
    email = "email"
    manual = "manual"


class Status(enum.StrEnum):
    confirmed = "confirmed"
    needs_review = "needs_review"


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