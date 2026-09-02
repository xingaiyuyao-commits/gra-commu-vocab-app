const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getStudyDay,
  canCreateRoom,
  getSubmissionSummary,
  calculateResult,
} = require("../public/ui-logic");

test("9月1日より前はDayを表示しない", () => {
  assert.equal(getStudyDay(new Date(2026, 7, 31, 23, 59)), null);
});

test("2026年9月1日をDay 1として毎日1ずつ進める", () => {
  assert.equal(getStudyDay(new Date(2026, 8, 1, 12, 0)), 1);
  assert.equal(getStudyDay(new Date(2026, 8, 2, 12, 0)), 2);
  assert.equal(getStudyDay(new Date(2026, 8, 30, 12, 0)), 30);
});

test("名前と単語帳の両方が揃った場合だけルームを作成できる", () => {
  assert.equal(canCreateRoom("", "clacel"), false);
  assert.equal(canCreateRoom("  ", "clacel"), false);
  assert.equal(canCreateRoom("Tina", null), false);
  assert.equal(canCreateRoom("Tina", "clacel"), true);
});

test("提出前に回答済み数・未回答数・未回答の問題番号を返す", () => {
  assert.deepEqual(getSubmissionSummary(["answer", " ", "word", ""]), {
    answered: 2,
    unanswered: 2,
    unansweredNumbers: [2, 4],
    total: 4,
  });
});

test("別解と大文字・前後空白を考慮して本人の点数と正答率を計算する", () => {
  const result = calculateResult(
    [" RUNS ", "learnt", "wrong", ""],
    [
      { answer: "runs" },
      { answer: "learned", altAnswers: ["learnt"] },
      { answer: "right" },
      { answer: "final" },
    ],
  );
  assert.deepEqual(result, { score: 2, total: 4, accuracy: 50 });
});
