const METHODS = {
    expense: [
        { value: "paypay", label: "PayPay" },
        { value: "cash", label: "現金" },
        { value: "points", label: "ポイント" },
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
  loadTransactions();
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

const directionButtons = document.querySelectorAll(".direction-toggle button");
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

  const line1 = document.createElement("div");
  line1.textContent = `${formatDateTime(tx.occurred_at)}　${tx.category}`;

  const amount = document.createElement("span");
  const sign = tx.direction === "expense" ? "-" : "+";
  amount.textContent = `${sign}¥${tx.amount.toLocaleString()}`;
  amount.className =
    tx.direction === "expense" ? "amount-expense" : "amount-income";

  const line2 = document.createElement("div");
  line2.append(amount);
  line2.append(
    document.createTextNode(`　${METHOD_LABELS[tx.method] || tx.method}`)
  );
  if (tx.memo) {
    line2.append(document.createTextNode(`　${tx.memo}`));
  }

  // --- 編集ボタン ---
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.textContent = "編集";
  editBtn.className = "edit-btn";
  editBtn.addEventListener("click", () => editTx(li, tx));

  // --- 削除ボタン（2クリック確認） ---
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

  li.append(line1, line2, editBtn, delBtn);
  return li;
}

// セレクトを作る（options は {value,label} か 文字列 の配列）
function makeSelect(options, selected) {
  const sel = document.createElement("select");
  options.forEach((o) => {
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

  const amountInp = document.createElement("input");
  amountInp.type = "number";
  amountInp.min = "1";
  amountInp.step = "1";
  amountInp.value = tx.amount;

  const dtInp = document.createElement("input");
  dtInp.type = "datetime-local";
  dtInp.value = tx.occurred_at.slice(0, 16);

  const methodSel = makeSelect(METHODS[tx.direction], tx.method);
  const categorySel = makeSelect(CATEGORIES[tx.direction], tx.category);

  const memoInp = document.createElement("input");
  memoInp.type = "text";
  memoInp.maxLength = 255;
  memoInp.value = tx.memo || "";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "保存";

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

  li.append(
    amountInp,
    dtInp,
    methodSel,
    categorySel,
    memoInp,
    saveBtn,
    cancelBtn,
    msg
  );
}

// 選択中の月の取引を取得して描画
async function loadTransactions() {
  const month = monthPicker.value || currentMonth();

  let response;
  try {
    response = await apiFetch(`/api/transactions?month=${month}`);
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
    li.textContent = "この月の記録はありません";
    txList.appendChild(li);
    return;
  }

  items.forEach((tx) => txList.appendChild(renderTx(tx)));
}

reloadBtn.addEventListener("click", loadTransactions);
monthPicker.addEventListener("change", loadTransactions);

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