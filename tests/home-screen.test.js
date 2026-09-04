const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const publicDir = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");

test("承認済みホームの見出し・学習日・画像を表示する", () => {
  assert.match(html, /<h1>ÖSH Vocabulary Challenge<\/h1>/);
  assert.match(html, /class="site-tagline">みんなで満点を目指そう！<\/p>/);
  assert.match(html, /<img[^>]+class="voice-logo"[^>]+src="\/assets\/voice-logo\.png"/);
  assert.match(html, /id="today-date"/);
  assert.match(html, /id="today-day"/);
  assert.match(html, /<img[^>]+src="\/assets\/osh-vocab-home-illustration\.png"/);
  assert.ok(fs.existsSync(path.join(publicDir, "assets", "osh-vocab-home-illustration.png")));
  assert.ok(fs.existsSync(path.join(publicDir, "assets", "voice-logo.png")));
  assert.match(html, /\.voice-logo\s*\{[^}]*mix-blend-mode:\s*multiply/);
});

test("ホームにルームコード手入力の参加導線を表示しない", () => {
  assert.doesNotMatch(html, /quiz\.html\?mode=join/);
  assert.doesNotMatch(html, /ルームコード.*参加/);
  assert.doesNotMatch(html, /class="join-cta"/);
});

test("ホームでは3コースを説明表示にし、開催導線は認証確認まで隠す", () => {
  const document = new JSDOM(html).window.document;
  const courseRows = [...document.querySelectorAll(".course-row")];

  assert.equal(courseRows.length, 3);
  assert.deepEqual(courseRows.map((row) => row.tagName), ["DIV", "DIV", "DIV"]);
  assert.deepEqual(courseRows.map((row) => row.querySelector("strong").textContent), ["Clacel", "TOEIC", "IELTS"]);
  const operatorEntry = document.querySelector('#operator-entry[href="/quiz.html?mode=create"]');
  assert.ok(operatorEntry);
  assert.equal(operatorEntry.hidden, true);
  assert.equal(operatorEntry.textContent.trim(), "開催画面を開く");
});

test("承認済みのコース説明と二段組レイアウトを表示する", () => {
  for (const copy of [
    "日常から仕事まで、使える英語を",
    "基礎を積み上げながら、英語を自分の言葉にしていくコースです",
    "スコアと実務につながる英語を",
    "頻出語を確実に身につけ、試験にも仕事にも活かします",
    "海外で学び、暮らすための英語を",
    "アカデミックな語彙を鍛え、世界へ踏み出す力を育てます",
    "開催画面を開く",
  ]) assert.ok(html.includes(copy), `${copy} を表示する`);

  assert.match(html, /class="home-content"/);
  assert.match(html, /@media\s*\(max-width:\s*900px\)/);
  assert.doesNotMatch(html, /[。]/, "ホームの短い説明文には句点を重ねない");
});

test("ホームの開催導線は認証済み応答のときだけ表示する", async () => {
  async function render(status) {
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      beforeParse(window) {
        window.QuizUi = { getStudyDay: () => null };
        window.fetch = async () => ({ status, ok: status === 200, json: async () => ({ authenticated: status === 200 }) });
      },
    });
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    return dom;
  }

  const unauthorized = await render(401);
  assert.equal(unauthorized.window.document.getElementById("operator-entry").hidden, true);
  unauthorized.window.close();

  const authenticated = await render(200);
  assert.equal(authenticated.window.document.getElementById("operator-entry").hidden, false);
  authenticated.window.close();
});
