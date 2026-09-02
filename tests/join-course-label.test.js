const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const quizHtml = fs.readFileSync(path.join(__dirname, "..", "public", "quiz.html"), "utf8");
const serverJs = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("参加リンクではコース名を名前入力より上に表示する", () => {
  const courseLabelIndex = quizHtml.indexOf('id="join-course-label"');
  const nameLabelIndex = quizHtml.indexOf('<label for="name">');

  assert.ok(courseLabelIndex >= 0, "コース名の表示欄がある");
  assert.ok(courseLabelIndex < nameLabelIndex, "コース名は名前入力より上にある");
  assert.match(quizHtml, /courseNameEl\.textContent = `\$\{nice\}コース`/);
  assert.match(quizHtml, /url\.searchParams\.set\('cat', category\)/);
});

test("再接続したホストがコピーする参加リンクにもコース情報を付ける", () => {
  assert.match(
    quizHtml,
    /renderJoinShare\("lobby-share", "lobby-join-url", "lobby-qr", "lobby-copy", session\.roomCode, selectedCategory\)/
  );
});

test("古い参加リンクでもルーム情報からコース名を表示する", () => {
  assert.match(quizHtml, /socket\.emit\("quiz:roomInfo", \{ roomCode: presetRoom \}/);
  assert.match(serverJs, /socket\.on\("quiz:roomInfo"/);
  assert.match(serverJs, /cb\(\{ category: room\.category \}\)/);
});
