# kakeibo — 個人用 家計簿アプリ

> **English summary**
> A personal household budgeting web app (PWA) for smartphones.
> Credit card usage emails in Gmail are imported automatically via Google Apps Script,
> and manual entries (cash, PayPay, etc.) can be added from the app.
> Built with FastAPI, SQLAlchemy, SQLite, and plain HTML/CSS/JavaScript (no build step).

スマホのホーム画面から使える、自分用の家計簿 Web アプリです。
クレジットカードの利用通知メールを自動で取り込み、現金や PayPay の支出はアプリから手で入力します。

## 主な機能

- **手入力**: 支出／収入、支払い方法、カテゴリをタップで選んで登録
- **メールの自動取り込み**: Gmail に届くカード利用通知を Google Apps Script が読み取り、API に送信
- **要確認フロー**: 取り込んだ明細は「未分類・要確認」で登録され、アプリでカテゴリを付けて確定
- **月ごとの集計**: 収入・支出の合計と、カテゴリ別の内訳を表示
- **編集・削除**: 明細の行をタップして修正
- **PWA 対応**: ホーム画面に追加して、アプリのように起動できる
- **簡易ログイン**: パスワード認証（連続で失敗すると一定時間ロック）

## 技術スタック

| 役割 | 使っているもの |
|---|---|
| バックエンド | Python / FastAPI / SQLAlchemy 2 / Pydantic v2 |
| データベース | SQLite |
| フロントエンド | HTML / CSS / JavaScript（フレームワーク・ビルドなし） |
| メール取り込み | Google Apps Script（clasp で管理） |
| 本番環境 | Oracle Cloud Always Free の VM（Ubuntu）＋ Caddy（HTTPS）＋ systemd |

## しくみ

```
[Gmail] カード利用通知メール
   │  Google Apps Script（10〜15分ごと）
   ▼
[FastAPI] POST /api/ingest/email ──► [SQLite]
   ▲                                    ▲
   │  /api/transactions, /api/summary   │
[スマホのブラウザ / PWA] ────────────────┘
```

- 画面のファイル（`frontend/`）も FastAPI が配信しているので、サーバーは 1 つだけです。
- 本番では Caddy が HTTPS を受け、手元の uvicorn に転送しています。

### 主な API

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/auth/login` | ログインしてトークンを受け取る |
| GET / POST | `/api/transactions` | 明細の一覧取得／追加 |
| PATCH / DELETE | `/api/transactions/{id}` | 明細の修正／削除 |
| GET | `/api/summary?month=YYYY-MM` | 月ごとの集計 |
| POST | `/api/ingest/email` | メール取り込み（GAS 専用。`X-Ingest-Token` ヘッダで認証） |
| GET | `/api/ingest/status` | 取り込めなかったメールの件数 |

サーバーを起動すると、`/docs` で API の一覧を試せます（FastAPI の自動生成ドキュメント）。

## ディレクトリ構成

```
kakeibo/
├── backend/          FastAPI アプリ
│   ├── main.py       アプリ本体（ルーターの登録と frontend/ の配信）
│   ├── models.py     DB のテーブル定義
│   ├── schemas.py    入出力の型と、カテゴリ・支払い方法の一覧
│   ├── auth.py       ログインと認証
│   ├── config.py     .env の読み込み
│   ├── database.py   DB 接続
│   ├── init_db.py    テーブル作成スクリプト
│   └── routers/      API（transactions / summary / ingest）
├── frontend/         画面（index.html / app.js / style.css / sw.js など）
├── gas/              メール取り込み用の Apps Script（詳細は gas/README.md）
└── data/             SQLite の DB ファイル（Git 管理外）
```

## ローカルで動かす

Python 3.10 以上が必要です。以下は Windows（PowerShell）の例です。

```powershell
# 1. 仮想環境を作って、ライブラリを入れる
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
```

```powershell
# 2. プロジェクト直下に .env を作る（値は自分で決めた長いランダムな文字列にする）
APP_PASSWORD=ログイン用のパスワード
AUTH_TOKEN=ログイン後に使うトークン
INGEST_TOKEN=GAS からの取り込み用トークン
```

ランダムな文字列は、たとえば `python -c "import secrets; print(secrets.token_urlsafe(32))"` で作れます。
`.env` は `.gitignore` に入っているので、Git にはコミットされません。

```powershell
# 3. テーブルを作って、サーバーを起動する
cd backend
python init_db.py
uvicorn main:app --reload
```

ブラウザで http://127.0.0.1:8000 を開き、`APP_PASSWORD` でログインします。

## 変更するときのメモ

### カテゴリを増やす・変える

カテゴリの一覧は **2 か所** に書かれているので、両方をそろえて直します。

1. `frontend/app.js` の `CATEGORIES`（画面のボタンの表示用）
2. `backend/schemas.py` の `EXPENSE_CATEGORIES` / `INCOME_CATEGORIES`（サーバー側の入力チェック用）

片方だけ直すと、「ボタンが出ない」か「保存するとエラーになる」のどちらかになります。

### 画面のファイルを変えたとき

`frontend/` のファイルを変えたら、`frontend/sw.js` の `CACHE_NAME`（例: `kakeibo-v10` → `kakeibo-v11`）を上げてください。
Service Worker が古いファイルを保存したままになり、スマホに新しい画面が表示されないためです。

## 本番環境への反映

VM に SSH でログインして、最新のコードを取り込み、サービスを再起動します。

```bash
cd ~/kakeibo
git pull
sudo systemctl restart kakeibo
```

## セキュリティ・個人情報について

- パスワードやトークンは `.env` に置き、リポジトリには含めていません。
- 家計簿のデータ（`data/`）はリポジトリに含めていません。
- メール取り込みの送信元アドレスや API の URL は、Apps Script のスクリプトプロパティに置いています。
