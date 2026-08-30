import models  # noqa: F401  読み込むことで Base.metadata にテーブル定義が登録される
from database import Base, engine

Base.metadata.create_all(bind=engine)
print("created tables:", list(Base.metadata.tables))