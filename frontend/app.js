const METHODS = {
    expense: [
        { value: "paypay", label: "PayPay" },
        { value: "cash", label: "現金" },
        { value: "points", label: "ポイント" },
        { value: "credit_card", label: "カード" },
    ],
    income: [
        { value: "bank_transfer", label: "銀行振込" },
        { value: "paypay", label: "PayPay" },
        { value: "cash", label: "現金" },
    ],
};

const CATEGORIES = {
  expense: ["食費", "娯楽費", "交際費", "その他"],
  income: ["給料", "おこづかい", "回収(食費)", "回収(交際費)", "その他"],
};

const TOKEN_KEY = "kakeibo_token";

// GAS が取り込めなかったメールに付ける Gmail ラベル名（gas/main.js と合わせる）
const UNPROCESSED_LABEL = "kakeibo/未処理";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");

function showLogin() {
  loginView.hidden = false;
  appView.hidden = true;
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  if (!monthPicker.value) monthPicker.value = currentMonth();
  showTab("input");
  loadTransactions();
  loadIngestStatus();
}

const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;

  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: loginPassword.value }),
  });

  if (!response.ok) {
    loginError.textContent = "パスワードが違います";
    loginError.hidden = false;
    return;
  }

  const data = await response.json(); // { token: "..." }
  localStorage.setItem(TOKEN_KEY, data.token);
  loginPassword.value = ""
  showApp();
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

async function apiFetch(url, options={}){
    const token = localStorage.getItem(TOKEN_KEY)
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`,
        },
    });
    if (response.status === 401){
        localStorage.removeItem(TOKEN_KEY);
        showLogin();
        throw new Error("認証が切れました。もう一度ログインしてください。")
    }
    return response;
}

let currentDirection = "expense"
let selectedMethod = null;
let selectedCategory = null;

const directionButtons = document.querySelectorAll(".segmented button");
const methodButtons = document.getElementById("method-buttons");
const categoryButtons = document.getElementById("category-buttons");
const occurredAt = document.getElementById("occurred-at");

function makeChoiceButton(label, onClick){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
}

function renderChoices() {
  methodButtons.innerHTML = "";
  categoryButtons.innerHTML = "";
  selectedMethod = null;
  selectedCategory = null;

  METHODS[currentDirection].forEach((m) => {
    const btn = makeChoiceButton(m.label, () => {
      selectedMethod = m.value;
      methodButtons
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
    methodButtons.appendChild(btn);
  });

  CATEGORIES[currentDirection].forEach((c) => {
    const btn = makeChoiceButton(c, () => {
      selectedCategory = c;
      categoryButtons
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
    categoryButtons.appendChild(btn);
  });
}

directionButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentDirection = btn.dataset.direction;
    directionButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderChoices();
  });
});

function nowForInput() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function setupForm() {
  renderChoices();
  occurredAt.value = nowForInput();
}

setupForm();

const txForm = document.getElementById("tx-form");
const amountInput = document.getElementById("amount");
const memoInput = document.getElementById("memo");
const txFormMsg = document.getElementById("tx-form-msg");

function showFormMsg(text, isError) {
  txFormMsg.textContent = text;
  txFormMsg.classList.toggle("error", isError);
  txFormMsg.classList.toggle("msg", !isError);
  txFormMsg.hidden = false;
}

txForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const amount = Number(amountInput.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    showFormMsg("金額は1以上の整数で入力してください", true);
    return;
  }
  if (!selectedMethod) {
    showFormMsg("支払い方法を選んでください", true);
    return;
  }
  if (!selectedCategory) {
    showFormMsg("カテゴリを選んでください", true);
    return;
  }

  const body = {
    occurred_at: occurredAt.value,
    direction: currentDirection,
    amount: amount,
    method: selectedMethod,
    category: selectedCategory,
    memo: memoInput.value.trim() || null,
  };

  let response;
  try {
    response = await apiFetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    showFormMsg(err.message, true);
    return;
  }

  if (!response.ok) {
    const detail = await response.text();
    console.log("保存失敗:", response.status, detail);
    showFormMsg("保存に失敗しました（詳細は Console）", true);
    return;
  }

  showFormMsg("保存しました", false);
  amountInput.value = "";
  memoInput.value = "";
  occurredAt.value = nowForInput();
  renderChoices();
  loadTransactions();
});

// ===== 一覧表示 =====
const monthPicker = document.getElementById("month-picker");
const reloadBtn = document.getElementById("reload-btn");
const txList = document.getElementById("tx-list");

// method の値 → 画面表示用の日本語
const METHOD_LABELS = {
  paypay: "PayPay",
  cash: "現金",
  points: "ポイント",
  bank_transfer: "銀行振込",
  credit_card: "カード",
};

// 「今月」を "YYYY-MM" で返す
function currentMonth() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ISO文字列 → "MM/DD HH:MM"
function formatDateTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

// 取引1件を <li> にする
function renderTx(tx) {
  const li = document.createElement("li");

  // 1行目左：カテゴリ（＋未確認バッジ）
  const title = document.createElement("div");
  title.className = "tx-title";
  title.textContent = tx.category;

  if (tx.status === "needs_review") {
    li.classList.add("needs-review");
    const badge = document.createElement("span");
    badge.className = "review-badge";
    badge.textContent = "要確認";
    title.append(badge);
  }

  // 1行目右：金額
  const amount = document.createElement("div");
  const sign = tx.direction === "expense" ? "-" : "+";
  amount.textContent = `${sign}¥${tx.amount.toLocaleString()}`;
  amount.className = `tx-amount ${
    tx.direction === "expense" ? "amount-expense" : "amount-income"
  }`;

  // タップできることを示す矢印
  const chevron = document.createElement("span");
  chevron.className = "tx-chevron";
  chevron.textContent = "›";

  const line1 = document.createElement("div");
  line1.className = "tx-main";
  line1.append(title, amount, chevron);

  // 2行目：日時・支払い方法・利用先・メモを「・」でつなぐ
  // 利用先はメール取り込みの行だけに入る。分類の手がかりになるので表示する。
  const parts = [
    formatDateTime(tx.occurred_at),
    METHOD_LABELS[tx.method] || tx.method,
  ];
  // 利用先は取り込み時にメモへ入れてある。画面に出すのはメモだけにして、
  // ユーザーが書き換え・削除できるようにする（merchant は元データとして保持）。
  if (tx.memo) parts.push(tx.memo);

  const line2 = document.createElement("div");
  line2.className = "tx-sub";
  line2.textContent = parts.join("・");

  // 行のどこを押しても編集に入れる（小さなボタンを狙わなくて済む）。
  // 編集中は中身のクリックがここへ伝わってくるので、その間は無視する。
  li.classList.add("tappable");
  li.addEventListener("click", () => {
    if (li.classList.contains("editing")) return;
    editTx(li, tx);
  });

  li.append(line1, line2);
  return li;
}

// セレクトを作る（options は {value,label} か 文字列 の配列）
function makeSelect(options, selected) {
  const sel = document.createElement("select");

  // 現在の値が選択肢に無いとき（メール取り込みの credit_card / 未分類 など）は
  // 先頭に足しておく。足さないと何も選択されず、ブラウザが先頭の項目を勝手に
  // 選ぶため、保存した瞬間に値が別のものへ書き換わってしまう。
  const values = options.map((o) => (typeof o === "string" ? o : o.value));
  const list = values.includes(selected)
    ? options
    : [{ value: selected, label: METHOD_LABELS[selected] || selected }, ...options];

  list.forEach((o) => {
    const value = typeof o === "string" ? o : o.value;
    const label = typeof o === "string" ? o : o.label;
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === selected) opt.selected = true;
    sel.append(opt);
  });
  return sel;
}

// 行を編集フォームに切り替える
function editTx(li, tx) {
  li.innerHTML = "";
  // 行のクリックで再び editTx が呼ばれないようにする目印
  li.classList.add("editing");
  li.classList.remove("tappable");

  const amountInp = document.createElement("input");
  amountInp.type = "number";
  amountInp.min = "1";
  amountInp.step = "1";
  amountInp.inputMode = "numeric";
  amountInp.value = tx.amount;

  const dtInp = document.createElement("input");
  dtInp.type = "datetime-local";
  dtInp.value = tx.occurred_at.slice(0, 16);

  const methodSel = makeSelect(METHODS[tx.direction], tx.method);
  const categorySel = makeSelect(CATEGORIES[tx.direction], tx.category);

  const memoInp = document.createElement("input");
  memoInp.type = "text";
  memoInp.maxLength = 255;
  // メール由来の行は取り込み時に利用先がメモへ入っているので、そのまま出せば
  // 書き換え・削除ができる。
  memoInp.value = tx.memo || "";
  memoInp.placeholder = "メモ";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "保存";
  saveBtn.className = "save-btn";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "キャンセル";

  const msg = document.createElement("p");
  msg.className = "error";
  msg.hidden = true;

  cancelBtn.addEventListener("click", loadTransactions);

  saveBtn.addEventListener("click", async () => {
    const amount = Number(amountInp.value);
    if (!Number.isInteger(amount) || amount <= 0) {
      msg.textContent = "金額は1以上の整数で入力してください";
      msg.hidden = false;
      return;
    }

    const body = {
      occurred_at: dtInp.value,
      amount: amount,
      method: methodSel.value,
      category: categorySel.value,
      memo: memoInp.value.trim() || null,
      // 編集して保存した＝内容を確認したということなので、要確認を解除する。
      status: "confirmed",
    };

    let res;
    try {
      res = await apiFetch(`/api/transactions/${tx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return;
    }
    if (!res.ok) {
      const detail = await res.text();
      console.log("編集失敗:", res.status, detail);
      msg.textContent = "保存に失敗しました（詳細は Console）";
      msg.hidden = false;
      return;
    }
    loadTransactions();
  });

  const box = document.createElement("div");
  box.className = "tx-edit";

  // --- 削除ボタン（2回タップで確定）---
  // 一覧では出さず、編集中だけ出す。誤って消すのを防ぐため。
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.textContent = "削除";
  delBtn.className = "del-btn";

  let armed = false;
  let timer = null;

  delBtn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = "本当に削除？";
      timer = setTimeout(() => {
        armed = false;
        delBtn.textContent = "削除";
      }, 3000);
      return;
    }

    clearTimeout(timer);
    try {
      const res = await apiFetch(`/api/transactions/${tx.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        console.log("削除失敗:", res.status);
        return;
      }
    } catch (err) {
      return;
    }
    loadTransactions();
  });

  const buttons = document.createElement("div");
  buttons.className = "tx-actions";
  buttons.append(saveBtn, cancelBtn, delBtn);

  // 入力フォームと同じ「ラベル＋値」の行に整える。
  // 日時だけは横並びにすると端末によって表示が切れるため、ラベルを上に置く。
  box.append(
    editRow("金額", amountInp),
    editRow("日時", dtInp, true),
    editRow("方法", methodSel),
    editRow("カテゴリ", categorySel),
    editRow("メモ", memoInp)
  );
  li.append(box, buttons, msg);
}

/** 編集フォームの1行を作る。stack=true ならラベルを上に置いて横幅いっぱいに使う。 */
function editRow(labelText, control, stack) {
  const row = document.createElement("label");
  row.className = stack ? "edit-row edit-row-stack" : "edit-row";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = labelText;

  row.append(label, control);
  return row;
}

// 「要確認」だけを表示しているかどうか（true のときは月の絞り込みを無視する）
let onlyNeedsReview = false;

// 取引を取得して描画。要確認モードのときは月をまたいで未確認の行だけ出す
async function loadTransactions() {
  const query = onlyNeedsReview
    ? "status=needs_review"
    : `month=${monthPicker.value || currentMonth()}`;

  let response;
  try {
    response = await apiFetch(`/api/transactions?${query}`);
  } catch (err) {
    return; // 401 のときは apiFetch がログイン画面へ戻している
  }
  if (!response.ok) {
    console.log("一覧取得失敗:", response.status);
    return;
  }

  const items = await response.json();
  txList.innerHTML = "";

  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = onlyNeedsReview
      ? "要確認の記録はありません"
      : "この月の記録はありません";
    txList.appendChild(li);
  } else {
    items.forEach((tx) => txList.appendChild(renderTx(tx)));
  }

  loadReviewCount();
  // 明細が変わったら集計もずれるので、必ず一緒に読み直す。
  // 保存・編集・削除のあとは必ずここを通るため、更新漏れが起きない。
  loadSummary();
}

// 要確認の件数を数えてボタンの表示を更新する
const reviewFilterBtn = document.getElementById("review-filter-btn");

async function loadReviewCount() {
  let response;
  try {
    response = await apiFetch("/api/transactions?status=needs_review");
  } catch (err) {
    return;
  }
  if (!response.ok) {
    return;
  }

  const count = (await response.json()).length;
  if (onlyNeedsReview) {
    reviewFilterBtn.textContent = "すべて表示";
    reviewFilterBtn.hidden = false;
  } else {
    reviewFilterBtn.textContent = `要確認 ${count}件`;
    reviewFilterBtn.hidden = count === 0;
  }
}

reviewFilterBtn.addEventListener("click", () => {
  onlyNeedsReview = !onlyNeedsReview;
  loadTransactions();
});

// メールから自動取り込みできなかった件数を表示する
const ingestNotice = document.getElementById("ingest-notice");

async function loadIngestStatus() {
  let response;
  try {
    response = await apiFetch("/api/ingest/status");
  } catch (err) {
    return; // 401 のときは apiFetch がログイン画面へ戻している
  }
  if (!response.ok) {
    console.log("取り込み状態の取得失敗:", response.status);
    return;
  }

  const data = await response.json(); // { unprocessed, reported_at, dismissed_at }
  if (data.unprocessed === 0) {
    ingestNotice.hidden = true;
    return;
  }

  ingestNotice.innerHTML = "";

  const text = document.createElement("span");
  text.textContent =
    `自動で取り込めなかったカード利用が ${data.unprocessed} 件あります。` +
    `Gmail のラベル「${UNPROCESSED_LABEL}」を確認して手入力してください（外貨での利用など）。`;

  // 手入力を終えたら、この時刻をサーバに記録してお知らせを消す。
  // 以後 GAS が報告してきても、これより古い未処理は数えられない。
  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "dismiss-btn";
  dismissBtn.textContent = "対応済みにする";
  dismissBtn.addEventListener("click", async () => {
    dismissBtn.disabled = true;
    try {
      const res = await apiFetch("/api/ingest/dismiss", { method: "POST" });
      if (!res.ok) {
        console.log("対応済みにできませんでした:", res.status);
        dismissBtn.disabled = false;
        return;
      }
    } catch (err) {
      dismissBtn.disabled = false;
      return;
    }
    ingestNotice.hidden = true;
  });

  ingestNotice.append(text, dismissBtn);
  ingestNotice.hidden = false;
}

reloadBtn.addEventListener("click", () => {
  loadTransactions();
  loadIngestStatus();
});
monthPicker.addEventListener("change", loadTransactions);

// ===== タブ切り替え =====
// 「いま表示しているタブ」を引数1つで表し、各パネルの hidden を付け外しする。
// パネルごとに個別のフラグを持つと、2つ同時に表示される状態を作れてしまう。
const tabButtons = document.querySelectorAll(".tabs button");
const panels = {
  input: document.getElementById("panel-input"),
  summary: document.getElementById("panel-summary"),
};

function showTab(name) {
  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== name;
  });
  tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("active", active);
    // 見た目だけでなく支援技術にも選択状態を伝える
    btn.setAttribute("aria-selected", String(active));
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    showTab(btn.dataset.tab);
    // 集計タブを開いた時点の最新の数字を見せる
    if (btn.dataset.tab === "summary") loadTransactions();
  });
});

// ===== 集計 =====
const sumIncome = document.getElementById("sum-income");
const sumExpense = document.getElementById("sum-expense");
const sumBalance = document.getElementById("sum-balance");
const sumReviewNote = document.getElementById("sum-review-note");
const sumExpenseList = document.getElementById("sum-expense-list");
const sumIncomeList = document.getElementById("sum-income-list");

function formatYen(n) {
  return `¥${n.toLocaleString()}`;
}

// カテゴリ別の内訳を <li> の並びにする。
// total は「合計に対する割合」の帯を描くための分母。
function renderBreakdown(list, items, total, color) {
  list.innerHTML = "";

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "sum-empty";
    li.textContent = "記録はありません";
    list.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "sum-row";

    const label = document.createElement("span");
    label.className = "sum-label";
    label.textContent = item.category;

    const count = document.createElement("span");
    count.className = "sum-count";
    count.textContent = `${item.count}件`;
    label.appendChild(count);

    const amount = document.createElement("span");
    amount.className = "tx-amount";
    amount.textContent = formatYen(item.amount);

    row.append(label, amount);

    // 簡易な棒グラフ。ライブラリを使わず div の幅を % で指定するだけ。
    const bar = document.createElement("div");
    bar.className = "sum-bar";
    const fill = document.createElement("div");
    fill.className = "sum-bar-fill";
    fill.style.width = total > 0 ? `${(item.amount / total) * 100}%` : "0%";
    fill.style.background = color;
    bar.appendChild(fill);

    li.append(row, bar);
    list.appendChild(li);
  });
}

async function loadSummary() {
  const month = monthPicker.value || currentMonth();

  let response;
  try {
    response = await apiFetch(`/api/summary?month=${month}`);
  } catch (err) {
    return; // 401 のときは apiFetch がログイン画面へ戻している
  }
  if (!response.ok) {
    console.log("集計取得失敗:", response.status);
    return;
  }

  const data = await response.json();

  sumIncome.textContent = formatYen(data.income_total);
  sumExpense.textContent = formatYen(data.expense_total);
  sumBalance.textContent = formatYen(data.balance);
  // 収支は符号で色を変える（プラスは収入色・マイナスは支出色・ゼロは無色）
  sumBalance.classList.toggle("amount-income", data.balance > 0);
  sumBalance.classList.toggle("amount-expense", data.balance < 0);

  // 集計には未確認の金額が混じる。カード通知は速報（承認額）なので
  // 確定額とずれることがあり、それを承知で見てもらうための注意書き。
  if (data.needs_review_count > 0) {
    sumReviewNote.textContent =
      `未確認 ${data.needs_review_count}件を含む金額です（カード通知は速報のため確定額とずれることがあります）`;
    sumReviewNote.hidden = false;
  } else {
    sumReviewNote.hidden = true;
  }

  renderBreakdown(
    sumExpenseList,
    data.expense_by_category,
    data.expense_total,
    "var(--expense)"
  );
  renderBreakdown(
    sumIncomeList,
    data.income_by_category,
    data.income_total,
    "var(--income)"
  );
}

function init() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    showApp();
  } else {
    showLogin();
  }
}

init();

// ===== PWA: Service Worker 登録 =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.log("Service Worker 登録失敗:", err);
    });
  });
}