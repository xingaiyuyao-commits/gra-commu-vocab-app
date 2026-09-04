const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "results-history.html"), "utf8");

const septemberRecords = [
  {
    date: "2026-09-05",
    category: "clacel",
    setLabel: "Clacel 体験会",
    participantCount: 32,
    perfectNames: ["Aica", "Miki", "<img src=x onerror=alert(1)>"],
    updatedAt: "2026-09-05T11:00:00.000Z",
  },
  {
    date: "2026-09-05",
    category: "toeic",
    setLabel: "TOEIC Day 25",
    participantCount: 3,
    perfectNames: [],
    updatedAt: "2026-09-05T11:00:00.000Z",
  },
  {
    date: "2026-09-18",
    category: "ielts",
    setLabel: "IELTS Week 4",
    participantCount: 12,
    perfectNames: ["Rina"],
    updatedAt: "2026-09-18T11:00:00.000Z",
  },
];

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function requestMethod(options) {
  return String(options?.method || "GET").toUpperCase();
}

function loadPage(handler) {
  const requests = [];
  const virtualConsole = new VirtualConsole().forwardTo(console, { jsdomErrors: ["unhandled-exception"] });
  const dom = new JSDOM(html, {
    url: "http://localhost/results-history.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const NativeDate = window.Date;
      window.Date = class FixedDate extends NativeDate {
        constructor(...args) {
          super(...(args.length ? args : ["2026-09-15T12:00:00.000Z"]));
        }
        static now() { return new NativeDate("2026-09-15T12:00:00.000Z").getTime(); }
      };
      window.fetch = async (url, options = {}) => {
        const request = { url: String(url), options, method: requestMethod(options) };
        requests.push(request);
        return handler(request, requests);
      };
      window.confirm = () => true;
    },
  });
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    requests,
    close() { dom.window.close(); },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

async function login(window, document, password = "history-admin-secret") {
  document.getElementById("history-password").value = password;
  document.getElementById("login-form").dispatchEvent(new window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  await settle();
}

test("未認証なら専用ログインを表示し、パスワードを保存せず認証後に履歴を開く", async (t) => {
  let authenticated = false;
  const page = loadPage(({ url, method }) => {
    if (url === "/api/results-history/login" && method === "POST") {
      authenticated = true;
      return response(200, { ok: true });
    }
    if (url === "/api/results-history?month=2026-09" && authenticated) return response(200, septemberRecords);
    return response(401, { error: "認証が必要です" });
  });
  t.after(() => page.close());
  await settle();

  assert.equal(page.document.getElementById("login-screen").hidden, false);
  assert.equal(page.document.getElementById("history-screen").hidden, true);
  assert.equal(page.document.querySelector('label[for="history-password"]').textContent.trim(), "パスワード");

  await login(page.window, page.document);
  assert.equal(page.document.getElementById("history-screen").hidden, false);
  assert.equal(page.document.getElementById("history-password").value, "", "入力後のパスワードをDOMに残さない");
  assert.equal(page.window.localStorage.length, 0);
  assert.equal(page.window.sessionStorage.length, 0);
  for (const request of page.requests) {
    assert.equal(request.options.credentials, "same-origin", `${request.method} ${request.url} は同一オリジンCookieを使う`);
  }
});

test("未設定の503はログインではなく運営向け設定エラーとして知らせる", async (t) => {
  const page = loadPage(() => response(503, { error: "結果履歴の認証が設定されていません" }));
  t.after(() => page.close());
  await settle();

  assert.equal(page.document.getElementById("login-screen").hidden, true);
  assert.equal(page.document.getElementById("setup-screen").hidden, false);
  assert.equal(page.document.getElementById("setup-error").getAttribute("role"), "alert");
  assert.match(page.document.getElementById("setup-error").textContent, /結果履歴の認証が設定されていません/);
});

test("初回取得の通信エラーを見えるalertで知らせる", async (t) => {
  const page = loadPage(() => response(500, { error: "履歴データを読み込めません" }));
  t.after(() => page.close());
  await settle();

  const alert = [...page.document.querySelectorAll('[role="alert"]')]
    .find((element) => element.textContent.includes("履歴データを読み込めません"));
  assert.ok(alert, "APIのエラー本文をalertへ表示する");
  assert.equal(alert.hidden, false);
  assert.equal(alert.closest("[hidden]"), null, "非表示画面の内側だけで通知しない");
});

test("月間カレンダーの日付にコース別ドットを出し、選択日の3コース詳細をすべて表示する", async (t) => {
  const page = loadPage(() => response(200, septemberRecords));
  t.after(() => page.close());
  await settle();

  assert.equal(page.document.getElementById("month-title").textContent.trim(), "2026年 9月");
  const day5 = page.document.querySelector('[data-date="2026-09-05"]');
  assert.ok(day5);
  assert.equal(day5.querySelectorAll(".course-dot").length, 2);
  assert.ok(day5.querySelector(".course-dot--clacel"));
  assert.ok(day5.querySelector(".course-dot--toeic"));

  click(page.window, day5);
  assert.match(page.document.getElementById("selected-date-title").textContent, /9月5日/);
  const clacel = page.document.querySelector('[data-course-card="clacel"]');
  assert.equal(clacel.querySelector('[data-field="participants"]').textContent.trim(), "32");
  assert.equal(clacel.querySelector('[data-field="perfect-count"]').textContent.trim(), "3");
  assert.deepEqual(
    [...clacel.querySelectorAll(".perfect-name")].map((element) => element.textContent),
    ["Aica", "Miki", "<img src=x onerror=alert(1)>"],
    "満点者を途中で省略せず全員表示する",
  );
  assert.equal(clacel.querySelector("img"), null, "API由来の名前をHTMLとして解釈しない");
  assert.ok(
    [...clacel.children].indexOf(clacel.querySelector(".perfect-list"))
      < [...clacel.children].indexOf(clacel.querySelector(".record-stats")),
    "満点者一覧を参加人数・満点者数より先に表示する",
  );

  const toeic = page.document.querySelector('[data-course-card="toeic"]');
  assert.equal(toeic.querySelector('[data-field="participants"]').textContent.trim(), "3");
  assert.equal(toeic.querySelector('[data-field="perfect-count"]').textContent.trim(), "0");
  assert.match(toeic.textContent, /満点者はいません/);

  const ielts = page.document.querySelector('[data-course-card="ielts"]');
  assert.match(ielts.textContent, /この日の記録はありません/);
});

test("結果履歴にもVOICEロゴと共通タイトルを表示する", async (t) => {
  const page = loadPage(() => response(200, septemberRecords));
  t.after(() => page.close());
  await settle();

  const header = page.document.querySelector(".site-header");
  assert.ok(header);
  assert.equal(header.querySelector(".voice-logo").getAttribute("src"), "/assets/voice-logo.png");
  assert.equal(header.querySelector(".site-title").textContent.trim(), "ÖSH Vocabulary Challenge");
});

test("別の日を選ぶと詳細を切り替え、前月・翌月ボタンは境界を越えた月を取得する", async (t) => {
  const page = loadPage(({ url }) => {
    if (url.endsWith("month=2026-08")) return response(200, []);
    if (url.endsWith("month=2026-09")) return response(200, septemberRecords);
    if (url.endsWith("month=2026-10")) return response(200, []);
    throw new Error(`unexpected request: ${url}`);
  });
  t.after(() => page.close());
  await settle();

  click(page.window, page.document.querySelector('[data-date="2026-09-18"]'));
  assert.match(page.document.getElementById("selected-date-title").textContent, /9月18日/);
  assert.match(page.document.querySelector('[data-course-card="ielts"]').textContent, /Rina/);

  click(page.window, page.document.getElementById("previous-month"));
  await settle();
  assert.ok(page.requests.some(({ url }) => url === "/api/results-history?month=2026-08"));

  click(page.window, page.document.getElementById("next-month"));
  await settle();
  click(page.window, page.document.getElementById("next-month"));
  await settle();
  assert.ok(page.requests.some(({ url }) => url === "/api/results-history?month=2026-10"));
});

test("確認後の削除が失敗したらエラーを通知し、対象コースカードを保持する", async (t) => {
  let confirmed = 0;
  const page = loadPage(({ method }) => {
    if (method === "DELETE") return response(500, { error: "結果履歴を保存できませんでした" });
    return response(200, septemberRecords);
  });
  page.window.confirm = () => { confirmed += 1; return true; };
  t.after(() => page.close());
  await settle();

  click(page.window, page.document.querySelector('[data-date="2026-09-05"]'));
  const card = page.document.querySelector('[data-course-card="clacel"]');
  click(page.window, card.querySelector(".delete-record"));
  await settle();

  assert.equal(confirmed, 1);
  const deletion = page.requests.find(({ method }) => method === "DELETE");
  assert.equal(deletion.url, "/api/results-history/2026-09-05/clacel");
  assert.equal(deletion.options.credentials, "same-origin");
  assert.match(page.document.getElementById("history-alert").textContent, /結果履歴を保存できませんでした/);
  assert.ok(page.document.querySelector('[data-course-card="clacel"] .delete-record'), "失敗した記録のカードを残す");
  assert.equal(page.document.querySelector('[data-course-card="clacel"] [data-field="participants"]').textContent.trim(), "32");
});
