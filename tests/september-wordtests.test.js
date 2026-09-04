const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data", "wordtests");
const STUDY_DAYS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25];

function loadDataset(course) {
  const file = path.join(DATA_DIR, `${course}-2026-09.json`);
  assert.equal(fs.existsSync(file), true, `${course}の最新版データがありません`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function standalonePattern(value) {
  return new RegExp(`(^|[^a-z])${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
}

test("承認済み9月教材は対象Dayと問題数が一致する", () => {
  const expectedTotals = { clacel: 420, toeic: 440, ielts: 440 };
  for (const [course, total] of Object.entries(expectedTotals)) {
    const data = loadDataset(course);
    assert.deepEqual(data.series.map(({ day }) => day), STUDY_DAYS, course);
    assert.equal(data.series.flatMap(({ items }) => items).length, total, course);
  }
});

test("全問題に固定IDと必須表示内容がある", () => {
  for (const course of ["clacel", "toeic", "ielts"]) {
    const data = loadDataset(course);
    const ids = new Set();
    for (const series of data.series) {
      series.items.forEach((item, index) => {
        assert.equal(item.questionId, `2026-09/${course}/day${String(series.day).padStart(2, "0")}/q${String(index + 1).padStart(2, "0")}`);
        assert.equal(ids.has(item.questionId), false, item.questionId);
        ids.add(item.questionId);
        for (const key of ["sentence", "answer", "base", "hint", "ja", "sentenceJa"]) {
          assert.ok(String(item[key] || "").trim(), `${item.questionId}: ${key}`);
        }
        assert.ok(item.sentence.includes("___"), `${item.questionId}: 空欄なし`);
      });
    }
  }
});

test("問題文と日本語ヒントに正答または見出し語を露出しない", () => {
  for (const course of ["clacel", "toeic", "ielts"]) {
    const data = loadDataset(course);
    for (const { items } of data.series) {
      for (const item of items) {
        const clue = `${item.sentence.replaceAll("___", "")} ${item.ja}`;
        for (const value of [item.answer, item.base]) {
          assert.equal(standalonePattern(value).test(clue), false, `${item.questionId}: ${value}`);
        }
      }
    }
  }
});

test("Clacelのleaveヒントは正答を含まない", () => {
  const clacel = loadDataset("clacel");
  const leave = clacel.series.flatMap(({ items }) => items).find(({ base }) => base === "leave");
  assert.ok(leave);
  assert.equal(leave.ja, "OをCのままにしておく、置き忘れる、去る");
  assert.equal(/leave/i.test(leave.ja), false);
});
