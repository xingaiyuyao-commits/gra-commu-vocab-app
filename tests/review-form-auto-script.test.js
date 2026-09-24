const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScript(tasks) {
  const filename = path.join(__dirname, "..", "scripts", "google-apps-script", "ReviewFormAuto.gs");
  const context = vm.createContext({ TASKS: tasks });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context;
}

function question(id) {
  return { questionId: id, answer: id, base: id, sentence: "___", hint: "a____", ja: "意味", sentenceJa: "訳" };
}

test("サイトが確定した50問の順序を保ってGoogleフォーム用タスクを作る", () => {
  const questions = Array.from({ length: 50 }, (_, index) => question(`q-${index + 1}`));
  const context = loadScript([
    { day: 15, course: "Clacel", questions: questions.slice(0, 25) },
    { day: 16, course: "Clacel", questions: questions.slice(25) },
  ]);

  const task = context.buildReviewTaskFromManifest_({
    reviewDay: 21,
    category: "clacel",
    course: "Clacel",
    questionIds: questions.map(({ questionId }) => questionId).reverse(),
  });

  assert.equal(task.day, 21);
  assert.equal(task.course, "Clacel");
  assert.equal(task.courseIndex, 0);
  assert.equal(task.questions.length, 50);
  assert.deepEqual(Array.from(task.questions, ({ questionId }) => questionId), questions.map(({ questionId }) => questionId).reverse());
});

test("サイトの50問に不足・重複があればフォームを作成せずエラーにする", () => {
  const questions = Array.from({ length: 49 }, (_, index) => question(`q-${index + 1}`));
  const context = loadScript([{ day: 15, course: "TOEIC", questions }]);

  assert.throws(
    () => context.buildReviewTaskFromManifest_({
      reviewDay: 21,
      category: "toeic",
      course: "TOEIC",
      questionIds: [...questions.map(({ questionId }) => questionId), "q-1"],
    }),
    /50問/,
  );
});

test("Apps Scriptのマニフェストにフォーム複製用のDrive権限がある", () => {
  const filename = path.join(__dirname, "..", "scripts", "google-apps-script", "appsscript.json");
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));

  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/drive"));
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/forms"));
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.external_request"));
});
