# gas/ — メール取り込み（Google Apps Script）

Gmail に届くクレジットカードの利用通知メールを読み取り、家計簿アプリの
取り込みAPI `POST /api/ingest/email` へ送る Google Apps Script です。

取り込まれた行は `source=email` / `status=needs_review` / `category=未分類` で登録され、
アプリの「要確認」からカテゴリを付けて確定させます。

## 仕組み

```
Gmail（利用通知メール）
  → GmailApp.search で過去7日分を取得
  → 本文を NFKC 正規化（全角英数字・全角記号を半角に）
  → 「利用日」の行で1件が始まり、続く「利用先」「利用金額」を1件にまとめる
  → 「メッセージID:連番」をSHA-256でハッシュ化して external_key に
  → UrlFetchApp で POST /api/ingest/email（ヘッダ X-Ingest-Token）
```

解析の前提となる本文の形（`getPlainBody()` が返すプレーンテキスト版。NFKC正規化後）:

```
◇利用日:2026/09/20 14:20
◇利用先:○○ストア
◇利用取引:買物
◇利用金額:800円
```

- **HTMLメールの見た目（表形式）とプレーンテキスト版は別物**。解析するのは後者。
  書式を調べるときは必ず `debugShowStructure` で `getPlainBody()` の中身を見ること。
- 「利用日」の行で1件が始まり、次の「利用日」かメール末尾までを1件分として扱う。
  1通のメールに複数件入っても取りこぼさない。
- 日時と金額が**両方そろった場合だけ**登録する。そのためフッターの
  「ご利用可能額:100,000円」のような行だけでは1件にならない。
- `external_key` はメッセージID＋連番のハッシュ（1通に複数件あるため連番が必要）。
- `occurred_at` は本文の利用日時（メールの受信日時ではない）。
- 記号（◇）の有無、「ご」の有無、「利用日」「利用日時」の違い、全角/半角コロン、
  行末の CR は吸収する。カード会社が細かく書式を変えても壊れにくくしてある。

同じメールを何度送っても、サーバ側の `external_key` の UNIQUE 制約で
2件目以降は `skipped` になります（冪等）。そのため「処理済み管理」は不要です。

## 関数

| 関数 | 用途 |
|---|---|
| `importBankEmails` | 本番用の入り口。**時間主導トリガーはこの名前に紐付いているので変更しないこと** |
| `dryRun` | 送信せず解析結果をログ出力するだけ。初回確認用 |
| `debugShowStructure`（`debug.js`） | メール本文の構造だけを、値を伏せてログ出力する診断用。書式が変わったときに使う |
| `collectItems` / `parseCardMessages` / `findDetailLine` / `formatOccurredAt` / `hashExternalKey` / `postToKakeibo` | 内部処理 |

## セットアップ

1. `clasp login` で Google アカウントにログイン
2. このディレクトリに `.clasp.json` を用意する（`scriptId` は個人のものなので Git には含めない）

   ```json
   { "scriptId": "<自分のスクリプトID>", "rootDir": "" }
   ```

3. Apps Script エディタの「プロジェクトの設定」→「スクリプト プロパティ」に以下を登録

   | キー | 値 |
   |---|---|
   | `OFFICIAL_ADDRESS` | 利用通知メールの送信元アドレス |
   | `API_BASE_URL` | 家計簿APIのベースURL（例: `https://example.duckdns.org`） |
   | `INGEST_TOKEN` | バックエンドの `.env` の `INGEST_TOKEN` と同じ値 |

4. `clasp push` でコードを反映
5. エディタで `dryRun` を実行し、解析結果をログで確認（初回は権限の承認が必要）
6. 問題なければ `importBankEmails` を実行し、アプリに行が入るか確認
7. 「トリガー」から時間主導トリガー（10〜15分ごと）を `importBankEmails` に設定

## 注意

- 秘密情報（トークン・メールアドレス・スクリプトID）はコードに書かず、
  スクリプトプロパティと `.clasp.json`（Git 管理外）に置くこと。
- カード会社の速報メールは「承認額」のため、確定額と差が出ることがあります。
  現時点では要確認画面での目視修正で対応します。
- 本文フォーマットが変わると正規表現が外れます。その場合は解析できないメールとして
  ログに警告が出るだけで取り込まれないので、定期的にログを確認してください。
