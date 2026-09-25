from datetime import datetime  # noqa: I001

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models import Direction, Method, Source, Status

UNCATEGORIZED = "未分類"
EXPENSE_CATEGORIES = {"食費", "娯楽費", "交際費", "その他", UNCATEGORIZED}
INCOME_CATEGORIES = {"給料", "おこづかい", "回収(食費)", "回収(交際費)", "その他"}

# credit_card は当初メール取り込み専用にしていたが、海外利用など自動で取り込めない
# カード決済を手入力する必要があるため、M6 で手入力も許可した。
EXPENSE_METHODS = {Method.paypay, Method.cash, Method.points, Method.credit_card}
INCOME_METHODS = {Method.bank_transfer, Method.paypay, Method.cash}

class TransactionCreate(BaseModel):
    occurred_at: datetime
    direction: Direction
    amount: int = Field(gt=0)
    method: Method
    category: str
    memo: str | None = None

    @model_validator(mode="after")
    def _check_direction_rules(self):
        if self.direction is Direction.expense:
            allowed_categories, allowed_methods = EXPENSE_CATEGORIES, EXPENSE_METHODS
        else:
            allowed_categories, allowed_methods = INCOME_CATEGORIES, INCOME_METHODS

        if self.category not in allowed_categories:
            raise ValueError(
                f"{self.direction.value} のカテゴリは {sorted(allowed_categories)} のいずれかにしてください"
            )
        if self.method not in allowed_methods:
            raise ValueError(
                f"{self.direction.value} の支払い方法は "
                f"{sorted(m.value for m in allowed_methods)} のいずれかにしてください"
            )
        return self

class TransactionUpdate(BaseModel):
    occurred_at: datetime | None = None
    amount: int | None = Field(default=None, gt=0)
    method: Method | None = None
    category: str | None = None
    memo: str | None = None
    status: Status | None = None
    # メール由来の利用先。編集時にメモへ移したあと null を送って消せるようにする。
    # model_dump(exclude_unset=True) なので「送らなければ変更なし」のまま。
    merchant: str | None = Field(default=None, max_length=255)

class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    occurred_at: datetime
    direction: Direction
    amount: int
    method: Method
    source: Source
    status: Status
    category: str
    memo: str | None
    merchant: str | None
    external_key: str | None
    created_at: datetime
    updated_at: datetime


class CategoryAmount(BaseModel):
    """カテゴリ1つぶんの集計結果。"""

    category: str
    amount: int
    count: int


class SummaryRead(BaseModel):
    """月ごとの集計。

    needs_review も含めて集計する。確定分だけに絞ると、メール由来の行が
    大半を占める現状では集計がほぼ空になって使えないため（M7 で決定）。
    """

    month: str
    income_total: int
    expense_total: int
    balance: int
    needs_review_count: int
    expense_by_category: list[CategoryAmount]
    income_by_category: list[CategoryAmount]
