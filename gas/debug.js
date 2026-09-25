/**
 * 診断用。メール本文の「構造」だけを確認する関数をまとめたファイル。
 *
 * 本文の中身（金額・利用先・日時）はログに出さない。
 * 数字は # に、英字は A に、ひらがな/カタカナ/漢字は あ/ア/漢 に置き換えて
 * 「形」だけを出すので、ログをそのまま共有しても安全。
 * 項目名（コロンより前）だけは原因究明に必要なのでそのまま表示する。
 */

/**
 * スクリプトプロパティの設定を、値を見せずに確認する。
 *
 * トークンは SHA-256 ハッシュの先頭8文字（指紋）と文字数だけを出す。
 * ハッシュからは元の値を復元できないので、サーバ側の指紋と突き合わせれば
 * 「同じ値かどうか」だけを安全に確認できる。
 */
function debugCheckProperties() {
  const props = PropertiesService.getScriptProperties();

  const token = props.getProperty("INGEST_TOKEN");
  if (!token) {
    console.log("INGEST_TOKEN: 未設定");
  } else {
    console.log(
      "INGEST_TOKEN: 文字数 %s / 指紋 %s",
      token.length,
      hashExternalKey(token).slice(0, 8)
    );
    if (token !== token.trim()) {
      console.warn("  → 前後に空白や改行が入っています（コピー時の混入）");
    }
  }

  const baseUrl = props.getProperty("API_BASE_URL");
  if (!baseUrl) {
    console.log("API_BASE_URL: 未設定");
  } else {
    console.log(
      "API_BASE_URL: 文字数 %s / https:// で始まる %s / 末尾スラッシュ %s",
      baseUrl.length,
      baseUrl.indexOf("https://") === 0,
      baseUrl.slice(-1) === "/"
    );
    if (baseUrl !== baseUrl.trim()) {
      console.warn("  → 前後に空白や改行が入っています");
    }
  }

  const address = props.getProperty("OFFICIAL_ADDRESS");
  console.log("OFFICIAL_ADDRESS: %s", address ? "設定あり" : "未設定");
}

/**
 * なぜ解析できないのかを切り分ける。
 * 1通目のメールについて、どの条件で失敗しているかを段階的に表示する。
 */
function debugWhyNotParsed() {
  const message = debugFirstMessage();
  if (!message) {
    console.log("対象メールが見つかりません");
    return;
  }

  const body = message.getPlainBody().normalize("NFKC");
  const lines = body.split("\n");
  console.log("本文 %s文字 / %s行", body.length, lines.length);

  // どの文字列が本文に含まれているか（値は出さず有無だけ）
  [
    "ご利用日時",
    "ご利用日",
    "利用日",
    "ご利用金額",
    "利用金額",
    "ご利用先",
    "ご利用内容",
    "円",
    "￥",
    "¥",
    ":",
    "/",
  ].forEach(function (probe) {
    console.log("  「%s」を含む: %s", probe, body.indexOf(probe) >= 0);
  });

  // 日時の前後がどうなっているか（数字→# 英字→A に伏せる）
  const dateMatch = body.match(/\d{4}\/\d{1,2}\/\d{1,2}(\s+\d{1,2}:\d{2})?/);
  if (dateMatch) {
    const at = body.indexOf(dateMatch[0]);
    const around = body.slice(Math.max(0, at - 40), at + 60);
    console.log("日付の周辺: %s", JSON.stringify(debugMaskValues(around)));
  }

  // 「円」の前後がどうなっているか（金額の書き方を特定する）
  const yenAt = body.indexOf("円");
  if (yenAt >= 0) {
    const around = body.slice(Math.max(0, yenAt - 40), yenAt + 20);
    console.log("「円」の周辺: %s", JSON.stringify(debugMaskValues(around)));
  }

  // 正規表現を段階的に試して、どこで外れるかを特定する
  console.log("--- 正規表現の当たり判定 ---");
  [
    ["ラベルのみ", /ご利用日時/],
    ["ラベル+コロン", /ご利用日時\s*:/],
    ["日付", /\d{4}\/\d{1,2}\/\d{1,2}/],
    ["日付+時刻", /\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/],
    ["現行の日時パターン", /ご利用日時\s*:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/],
    ["明細行（利用先＋金額円）", /^(.+?)\s+([\d,]+)円/m],
    ["金額だけの行", /^\s*([\d,]+)円\s*$/m],
  ].forEach(function (entry) {
    console.log("  %s %s", entry[1].test(body) ? "○" : "×", entry[0]);
  });
}

/**
 * 本文の各行の「形」を表示する。値は伏せ、項目名だけそのまま出す。
 * 空行は除いてから最大80行。タブや全角スペースが分かるよう JSON 形式で出す。
 */
function debugShowStructure() {
  const message = debugFirstMessage();
  if (!message) {
    console.log("対象メールが見つかりません");
    return;
  }
  debugPrintStructure(message, 80);
}

/**
 * 解析できなかったメールだけを探して、その構造を表示する。
 * 「取り込むべき取引なのに読めていない」のか「そもそも取引の通知ではない」のかを
 * 見分けるために使う。
 */
function debugShowUnparsed() {
  const officialAddress =
    PropertiesService.getScriptProperties().getProperty("OFFICIAL_ADDRESS");
  if (!officialAddress) {
    throw new Error("スクリプトプロパティ OFFICIAL_ADDRESS を設定してください");
  }

  const query = "from:" + officialAddress + ' "ご利用のお知らせ" newer_than:7d';
  const threads = GmailApp.search(query, 0, 100);
  let messageCount = 0;
  let shown = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      messageCount += 1;
      if (parseCardMessages(message).items.length > 0 || shown >= 3) {
        return;
      }
      shown += 1;
      console.log("########## 解析できなかった %s通目 ##########", messageCount);
      debugPrintStructure(message, 40);
    });
  });

  if (shown === 0) {
    console.log("解析できなかったメールはありません");
  }
}

/** メール1通の本文の「形」を出力する（値は伏せる）。 */
function debugPrintStructure(message, maxLines) {
  console.log("件名: %s", message.getSubject());
  console.log("受信: %s", message.getDate());

  const lines = message
    .getPlainBody()
    .normalize("NFKC")
    .split(/\r?\n/)
    .filter(function (line) {
      return line.trim() !== "";
    })
    .slice(0, maxLines);

  lines.forEach(function (line, index) {
    const colonAt = line.search(/[:：]/);
    // 項目名（コロンより前）は原因究明に必要なのでそのまま出し、
    // 値（コロンより後ろ）は必ず「形」に置き換えて伏せる。
    const shown =
      colonAt >= 0
        ? "[項目] " + line.slice(0, colonAt + 1) + debugShape(line.slice(colonAt + 1))
        : "[形]   " + debugShape(line);
    console.log("%s %s", index, JSON.stringify(shown));
  });
}

/** 検索条件に合う最初のメールを1通返す。 */
function debugFirstMessage() {
  const officialAddress =
    PropertiesService.getScriptProperties().getProperty("OFFICIAL_ADDRESS");
  if (!officialAddress) {
    throw new Error("スクリプトプロパティ OFFICIAL_ADDRESS を設定してください");
  }

  const query = "from:" + officialAddress + ' "ご利用のお知らせ" newer_than:7d';
  const threads = GmailApp.search(query, 0, 1);
  if (threads.length === 0) {
    return null;
  }
  const messages = threads[0].getMessages();
  return messages.length > 0 ? messages[0] : null;
}

/**
 * 文字を種類ごとの記号に置き換えて「形」だけにする。
 * 数字→# / 英字→A / ひらがな→あ / カタカナ→ア / 漢字→漢
 * 記号・スペース・タブはそのまま残す（区切り文字を見たいため）。
 */
function debugShape(text) {
  return text
    .replace(/[0-9]/g, "#")
    .replace(/[A-Za-z]/g, "A")
    .replace(/[ぁ-ゟ]/g, "あ")
    .replace(/[゠-ヿ]/g, "ア")
    .replace(/[一-鿿]/g, "漢");
}

/** 文字列を「文字(U+コード)」の並びに変換する（見えない文字を可視化する）。 */
function debugCodePoints(text) {
  return Array.from(text)
    .map(function (ch) {
      return ch + "(U+" + ch.codePointAt(0).toString(16).toUpperCase() + ")";
    })
    .join(" ");
}

/**
 * 解析結果が正しい形かを自動チェックする。送信はしない。
 *
 * 金額・利用先・日時などの値は一切ログに出さず、合否と件数だけを出すので、
 * 結果をそのまま共有できる。
 */
function verifyDryRun() {
  const officialAddress =
    PropertiesService.getScriptProperties().getProperty("OFFICIAL_ADDRESS");
  if (!officialAddress) {
    throw new Error("スクリプトプロパティ OFFICIAL_ADDRESS を設定してください");
  }

  const query = "from:" + officialAddress + ' "ご利用のお知らせ" newer_than:7d';
  const threads = GmailApp.search(query, 0, 100);
  const items = [];
  let messageCount = 0;
  let unprocessed = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      messageCount += 1;
      const parsed = parseCardMessages(message);
      console.log(
        "メール %s通目 → %s件（未処理 %s件）",
        messageCount,
        parsed.items.length,
        parsed.unprocessed
      );
      parsed.items.forEach(function (item) {
        items.push(item);
      });
      unprocessed += parsed.unprocessed;
    });
  });

  console.log("-------------------------");
  console.log(
    "メール %s通 / 取り込み候補 %s件 / 未処理 %s件",
    messageCount,
    items.length,
    unprocessed
  );

  const problems = [];
  if (items.length === 0) {
    problems.push("1件も解析できていない");
  }

  const seenKeys = {};
  items.forEach(function (item, index) {
    const no = index + 1;

    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.occurred_at)) {
      problems.push(no + "件目: occurred_at の形式が不正");
    } else {
      const when = new Date(item.occurred_at).getTime();
      const now = Date.now();
      if (isNaN(when)) {
        problems.push(no + "件目: occurred_at が日付として解釈できない");
      } else if (when > now + 60 * 60 * 1000) {
        problems.push(no + "件目: occurred_at が未来の日時になっている");
      } else if (now - when > 30 * 24 * 60 * 60 * 1000) {
        problems.push(no + "件目: occurred_at が30日以上前（検索範囲は7日なので異常）");
      }
    }

    if (!Number.isInteger(item.amount) || item.amount <= 0) {
      problems.push(no + "件目: amount が正の整数でない");
    } else if (item.amount > 10000000) {
      problems.push(no + "件目: amount が1000万円超（桁の読み違いの疑い）");
    }

    if (!item.merchant || item.merchant.length === 0) {
      problems.push(no + "件目: merchant が空");
    } else if (item.merchant.length > 255) {
      problems.push(no + "件目: merchant が255文字を超えている");
    } else if (/[Ａ-Ｚａ-ｚ０-９]/.test(item.merchant)) {
      problems.push(no + "件目: merchant に全角英数字が残っている（正規化漏れ）");
    } else if (/[\t\r\n]/.test(item.merchant)) {
      problems.push(no + "件目: merchant にタブや改行が混ざっている");
    }

    if (!/^[0-9a-f]{64}$/.test(item.external_key)) {
      problems.push(no + "件目: external_key が64文字の16進文字列でない");
    } else if (seenKeys[item.external_key]) {
      problems.push(no + "件目: external_key が他の件と重複（別々に登録されない）");
    }
    seenKeys[item.external_key] = true;
  });

  console.log("-------------------------");
  if (problems.length === 0) {
    console.log("チェック結果: すべてOK（%s件）", items.length);
  } else {
    console.log("チェック結果: 問題 %s件", problems.length);
    problems.forEach(function (problem) {
      console.log("  NG %s", problem);
    });
  }
  console.log(
    "※ この %s件が、実際のカード利用件数（過去7日）と合っているかは目視で確認してください",
    items.length
  );
}
