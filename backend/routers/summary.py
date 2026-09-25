from fastapi import APIRouter, Depends, Query  # noqa: I001
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import require_auth
from database import get_db
from models import Direction, Status, Transaction
from schemas import CategoryAmount, SummaryRead

router = APIRouter(
    prefix="/api/summary",
    tags=["summary"],
    dependencies=[Depends(require_auth)],
)


@router.get("", response_model=SummaryRead)
def get_summary(
    month: str = Query(pattern=r"^\d{4}-\d{2}$"),
    db: Session = Depends(get_db),
):
    """指定月の集計を返す。

    status では絞らない（needs_review も含める）。合計はDBに保存せず毎回数える。
    保存すると明細を編集したときに更新を忘れてズレるため。
    """
    # 一覧APIと同じ月の絞り込み方。strftime は SQLite の日時整形関数で、
    # "2026-09-25 14:30" を "2026-09" にしてから month と比べる。
    in_month = func.strftime("%Y-%m", Transaction.occurred_at) == month

    # 「収入/支出 × カテゴリ」の組み合わせごとに1行へまとめる。
    # 収入合計・支出合計はこの結果を足せば出るので、別クエリは不要。
    stmt = (
        select(
            Transaction.direction,
            Transaction.category,
            func.sum(Transaction.amount).label("amount"),
            func.count().label("count"),
        )
        .where(in_month)
        .group_by(Transaction.direction, Transaction.category)
        .order_by(func.sum(Transaction.amount).desc())
    )

    expense: list[CategoryAmount] = []
    income: list[CategoryAmount] = []
    for direction, category, amount, count in db.execute(stmt):
        bucket = expense if direction == Direction.expense else income
        bucket.append(CategoryAmount(category=category, amount=amount, count=count))

    expense_total = sum(row.amount for row in expense)
    income_total = sum(row.amount for row in income)

    # 「この集計には未確認の金額が N 件混じっている」と画面に出すための件数。
    # カード通知メールは速報（承認額）なので確定額とズレることがある。
    needs_review_count = db.scalar(
        select(func.count())
        .select_from(Transaction)
        .where(in_month, Transaction.status == Status.needs_review)
    )

    return SummaryRead(
        month=month,
        income_total=income_total,
        expense_total=expense_total,
        balance=income_total - expense_total,
        needs_review_count=needs_review_count or 0,
        expense_by_category=expense,
        income_by_category=income,
    )
