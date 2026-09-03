const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getStudyDay,
  getProjectWeek,
  canCreateRoom,
  getSubmissionSummary,
  calculateResult,
} = require("../public/ui-logic");

test("正式Day 1の開始前はDayを表示しない", () => {
  assert.equal(getStudyDay(new Date("2026-09-06T19:29:59+09:00")), null);
});

test("2026年9月6日19時30分をDay 1として毎日1ずつ進める", () => {
  assert.equal(getStudyDay(new Date("2026-09-06T19:30:00+09:00")), 1);
  assert.equal(getStudyDay(new Date("2026-09-07T19:29:59+09:00")), 1);
  assert.equal(getStudyDay(new Date("2026-09-07T19:30:00+09:00")), 2);
});

test("プロジェクト週は正式Day 1の開始時刻から7日ごとに区切る", () => {
  assert.equal(getProjectWeek(new Date("2026-09-06T19:29:59+09:00")), null);
  assert.deepEqual(getProjectWeek(new Date("2026-09-06T19:30:00+09:00")), {
    id: "2026-09-06",
    startsAt: Date.parse("2026-09-06T19:30:00+09:00"),
    endsAt: Date.parse("2026-09-13T19:30:00+09:00"),
  });
  assert.deepEqual(getProjectWeek(new Date("2026-09-13T19:30:00+09:00")), {
    id: "2026-09-13",
    startsAt: Date.parse("2026-09-13T19:30:00+09:00"),
    endsAt: Date.parse("2026-09-20T19:30:00+09:00"),
  });
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
