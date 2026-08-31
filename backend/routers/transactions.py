from fastapi import APIRouter, Depends, HTTPException, Query  # noqa: I001
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth import require_auth
from database import get_db
from models import Direction, Source, Status, Transaction
from schemas import (
    EXPENSE_CATEGORIES,
    INCOME_CATEGORIES,
    TransactionCreate,
    TransactionRead,
    TransactionUpdate,
)

router = APIRouter(
    prefix="/api/transactions",
    tags=["transactions"],
    dependencies=[Depends(require_auth)],
)

@router.get("", response_model=list[TransactionRead])
def list_transactions(
    month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    direction: Direction | None = None,
    status: Status | None = None,
    db: Session = Depends(get_db),
):
    stmt = select(Transaction).order_by(Transaction.occurred_at.desc())
    if month:
        stmt = stmt.where(func.strftime("%Y-%m", Transaction.occurred_at) == month)
    if direction:
        stmt = stmt.where(Transaction.direction == direction)
    if status:
        stmt = stmt.where(Transaction.status == status)
    return db.scalars(stmt).all()

@router.post("", response_model=TransactionRead, status_code=201)
def create_transaction(payload: TransactionCreate, db: Session = Depends(get_db)):
    row = Transaction(
        occurred_at=payload.occurred_at,
        direction=payload.direction,
        amount=payload.amount,
        method=payload.method,
        category=payload.category,
        memo=payload.memo,
        source=Source.manual,
        status=Status.confirmed,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row

@router.patch("/{transaction_id}", response_model=TransactionRead)
def update_transaction(
    transaction_id: int,
    payload: TransactionUpdate,
    db: Session = Depends(get_db),
):
    row = db.get(Transaction, transaction_id)
    if row is None:
        raise HTTPException(status_code=404, detail="取引が見つかりません")

    data = payload.model_dump(exclude_unset=True)

    if "category" in data:
        allowed = (
            EXPENSE_CATEGORIES
            if row.direction is Direction.expense
            else INCOME_CATEGORIES
        )
        if data["category"] not in allowed:
            raise HTTPException(
                status_code=422,
                detail=f"{row.direction.value} のカテゴリは {sorted(allowed)} のいずれかにしてください",
            )

    for key, value in data.items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return row

@router.delete("/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: int, db: Session = Depends(get_db)):
    row = db.get(Transaction, transaction_id)
    if row is None:
        raise HTTPException(status_code=404, detail="取引が見つかりません")
    db.delete(row)
    db.commit()