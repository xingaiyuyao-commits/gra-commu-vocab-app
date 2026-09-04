const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

test("3コースのルーム作成導線を保つ", () => {
  assert.match(html, /class="course-row" href="\/quiz\.html\?mode=create"[\s\S]*01[\s\S]*Clacel/);
  assert.match(html, /class="course-row" href="\/quiz\.html\?mode=create"[\s\S]*02[\s\S]*TOEIC/);
  assert.match(html, /class="course-row" href="\/quiz\.html\?mode=create"[\s\S]*03[\s\S]*IELTS/);
});

test("承認済みのコース説明と二段組レイアウトを表示する", () => {
  for (const copy of [
    "日常から仕事まで、使える英語を",
    "基礎を積み上げながら、英語を自分の言葉にしていくコースです",
    "スコアと実務につながる英語を",
    "頻出語を確実に身につけ、試験にも仕事にも活かします",
    "海外で学び、暮らすための英語を",
    "アカデミックな語彙を鍛え、世界へ踏み出す力を育てます",
    "運営用",
  ]) assert.ok(html.includes(copy), `${copy} を表示する`);

  assert.match(html, /class="home-content"/);
  assert.match(html, /@media\s*\(max-width:\s*900px\)/);
  assert.doesNotMatch(html, /[。]/, "ホームの短い説明文には句点を重ねない");
});
