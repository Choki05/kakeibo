/**
 * クレジットカードの利用通知メールを Gmail から読み取り、
 * 家計簿アプリの取り込みAPI (POST /api/ingest/email) へ送る。
 *
 * 設定値はすべてスクリプトプロパティに置く（コードに秘密情報を書かない）:
 *   API_BASE_URL     : 家計簿APIのベースURL（例: https://example.duckdns.org）
 *   INGEST_TOKEN     : バックエンドの .env と同じ取り込み用トークン
 *   OFFICIAL_ADDRESS : 利用通知メールの送信元アドレス
 *
 * 時間主導トリガーは importBankEmails に紐付いている。
 * 関数名を変えるとトリガーが外れるので注意。
 */

/** 円換算できず取り込めなかったメールに付ける Gmail ラベル。 */
const UNPROCESSED_LABEL = "kakeibo/未処理";

function importBankEmails() {
  const props = PropertiesService.getScriptProperties();
  const apiBaseUrl = props.getProperty("API_BASE_URL");
  const ingestToken = props.getProperty("INGEST_TOKEN");
  const officialAddress = props.getProperty("OFFICIAL_ADDRESS");

  if (!apiBaseUrl || !ingestToken || !officialAddress) {
    throw new Error(
      "スクリプトプロパティ (API_BASE_URL / INGEST_TOKEN / OFFICIAL_ADDRESS) を設定してください"
    );
  }

  const collected = collectItems(officialAddress);
  if (collected.items.length === 0 && collected.unprocessed === 0) {
    console.log("対象メールなし");
    return;
  }

  const result = postToKakeibo(
    apiBaseUrl,
    ingestToken,
    collected.items,
    collected.unprocessed
  );
  labelUnprocessedThreads(collected.unprocessedThreads);

  console.log(
    "送信 %s件 / 登録 %s件 / 重複スキップ %s件 / 未処理 %s件",
    collected.items.length,
    result.inserted,
    result.skipped,
    collected.unprocessed
  );
}

/**
 * 送信せず、解析結果だけログに出す。初回の動作確認用。
 */
function dryRun() {
  const officialAddress =
    PropertiesService.getScriptProperties().getProperty("OFFICIAL_ADDRESS");
  if (!officialAddress) {
    throw new Error("スクリプトプロパティ OFFICIAL_ADDRESS を設定してください");
  }

  const collected = collectItems(officialAddress);
  console.log(
    "%s件を解析（未処理 %s件）:",
    collected.items.length,
    collected.unprocessed
  );
  collected.items.forEach(function (item) {
    console.log(JSON.stringify(item));
  });
}

/**
 * Gmail を検索して、取り込み用データと未処理件数を集める。
 * 過去7日分を毎回送るが、重複はサーバ側が external_key で弾く。
 *
 * @return {{items: Array, unprocessed: number, unprocessedThreads: Array}}
 */
function collectItems(officialAddress) {
  const query = "from:" + officialAddress + ' "ご利用のお知らせ" newer_than:7d';
  const threads = GmailApp.search(query, 0, 100);
  const items = [];
  const unprocessedThreads = [];
  let unprocessed = 0;

  threads.forEach(function (thread) {
    let threadUnprocessed = 0;

    thread.getMessages().forEach(function (message) {
      const parsed = parseCardMessages(message);
      parsed.items.forEach(function (item) {
        items.push(item);
      });
      threadUnprocessed += parsed.unprocessed;
    });

    if (threadUnprocessed > 0) {
      unprocessed += threadUnprocessed;
      unprocessedThreads.push(thread);
    }
  });

  return {
    items: items,
    unprocessed: unprocessed,
    unprocessedThreads: unprocessedThreads,
  };
}

/**
 * メール1通を取り込み用データに変換する（1通に複数件入ることがある）。
 *
 * 想定する本文の形（NFKC正規化後）:
 *   ◇利用日:2026/09/20 14:20
 *   ◇利用先:○○ストア
 *   ◇利用取引:買物
 *   ◇利用金額:800円            ← 海外利用だと「27,460.00 JPY」「222,100.00 KRW」
 *
 * 「利用日」の行で1件が始まり、次の「利用日」またはメール末尾までが1件分。
 * 日時はあるのに日本円の金額が取れなかったものは unprocessed として数える
 * （外貨建て＝円換算額がこのメールには無いため、取り込まず後で手入力する）。
 *
 * @return {{items: Array, unprocessed: number}}
 */
function parseCardMessages(message) {
  // NFKC正規化: 全角英数字・全角記号・全角スペースを半角に揃える。
  // 「１，２３４」→「1,234」、「：」→「:」、「　」→「 」。
  const lines = message.getPlainBody().normalize("NFKC").split(/\r?\n/);
  const items = [];
  let unprocessed = 0;
  let current = null;

  /** 組み立て中の1件を確定させる。円の金額が無ければ未処理として数える。 */
  const flush = function () {
    if (!current) {
      return;
    }
    if (current.amount) {
      items.push({
        occurred_at: current.occurred_at,
        amount: current.amount,
        merchant: current.merchant,
        // 1通に複数件あるので、メッセージIDだけでは重複してしまう。
        // 何件目かを足してから、まとめてハッシュ化する。
        external_key: hashExternalKey(message.getId() + ":" + items.length),
      });
    } else {
      unprocessed += 1;
      console.warn(
        "円の金額が取れないため未処理: %s（通貨 %s）",
        message.getSubject(),
        current.currency || "不明"
      );
    }
    current = null;
  };

  lines.forEach(function (line) {
    const dateMatch = line.match(
      /^\s*[◇◆■*]?\s*(?:ご)?利用日時?\s*[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/
    );
    if (dateMatch) {
      // 次の1件が始まったので、直前の1件を確定させる。
      flush();
      current = {
        occurred_at: formatOccurredAt(dateMatch),
        amount: null,
        merchant: null,
        currency: null,
      };
      return;
    }

    // 「利用日」より前の行（あいさつ文など）は無視する。
    if (!current) {
      return;
    }

    const merchantMatch = line.match(
      /^\s*[◇◆■*]?\s*(?:ご)?利用先\s*[:：]\s*(\S.*)$/
    );
    if (merchantMatch) {
      current.merchant = merchantMatch[1].trim().slice(0, 255);
      return;
    }

    // 金額は「800円」だけでなく「27,460.00 JPY」「222,100.00 KRW」の形もある。
    const amountMatch = line.match(
      /^\s*[◇◆■*]?\s*(?:ご)?利用金額\s*[:：]\s*([\d,]+(?:\.\d+)?)\s*(円|[A-Za-z]{3})?/
    );
    if (amountMatch) {
      const value = Number(amountMatch[1].replace(/,/g, ""));
      const currency = (amountMatch[2] || "円").toUpperCase();
      current.currency = currency;
      if (currency === "円" || currency === "JPY") {
        // 日本円。小数（27,460.00）は四捨五入して整数の円にする。
        current.amount = Math.round(value);
      }
      // 外貨のときは amount を入れない → flush で未処理として数えられる。
    }
  });
  flush();

  if (items.length === 0 && unprocessed === 0) {
    console.warn("解析できないメールをスキップ: %s", message.getSubject());
  }
  return { items: items, unprocessed: unprocessed };
}

/**
 * 正規表現の結果から "2026-09-20T14:20:00" の形を組み立てる。
 * DB は JST の naive datetime で統一しているのでオフセットは付けない。
 */
function formatOccurredAt(dateMatch) {
  const pad = function (value) {
    return ("0" + value).slice(-2);
  };
  // 時刻が無い書式のメールも想定し、その場合は 00:00 とする。
  const hour = dateMatch[4] === undefined ? "0" : dateMatch[4];
  const minute = dateMatch[5] === undefined ? "0" : dateMatch[5];
  return (
    dateMatch[1] +
    "-" + pad(dateMatch[2]) +
    "-" + pad(dateMatch[3]) +
    "T" + pad(hour) +
    ":" + pad(minute) +
    ":00"
  );
}

/**
 * 文字列を SHA-256 の16進文字列にする（external_key 用）。
 * 必ず64文字になるので DB の列幅に収まる。
 */
function hashExternalKey(seed) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    seed,
    Utilities.Charset.UTF_8
  );
  return bytes
    .map(function (b) {
      return ("0" + (b & 0xff).toString(16)).slice(-2);
    })
    .join("");
}

/**
 * 取り込めなかったメールに Gmail ラベルを付ける。
 * 後から Gmail 上で一覧し、アプリに手入力するための目印。
 */
function labelUnprocessedThreads(threads) {
  if (threads.length === 0) {
    return;
  }

  let label = GmailApp.getUserLabelByName(UNPROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(UNPROCESSED_LABEL);
  }
  threads.forEach(function (thread) {
    thread.addLabel(label);
  });
  console.log(
    "Gmailラベル「%s」を %s スレッドに付けました",
    UNPROCESSED_LABEL,
    threads.length
  );
}

/**
 * 取り込みAPIへ POST する。
 * 失敗したら例外を投げ、トリガー失敗としてGASから通知メールを飛ばす。
 */
function postToKakeibo(apiBaseUrl, ingestToken, items, unprocessed) {
  const url = apiBaseUrl.replace(/\/$/, "") + "/api/ingest/email";
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Ingest-Token": ingestToken },
    payload: JSON.stringify({ items: items, unprocessed: unprocessed }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(
      "取り込みAPIがエラーを返しました: " + code + " " + response.getContentText()
    );
  }
  return JSON.parse(response.getContentText());
}
