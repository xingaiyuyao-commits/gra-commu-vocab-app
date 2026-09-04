const test = require("node:test");
const assert = require("node:assert/strict");

const { selectReviewQuestions, ReviewSelectionError } = require("../quiz-review-selection");

function item(day, number) {
  return {
    questionId: `2026-09/clacel/day${String(day).padStart(2, "0")}/q${String(number).padStart(2, "0")}`,
    sentence: `Day ${day} question ${number}: ___`,
    answer: `answer${day}-${number}`,
    base: `base${day}-${number}`,
    hint: "b___",
    ja: "意味",
    sentenceJa: "例文訳",
  };
}

function fixture({ counts = {}, history = {} } = {}) {
  const sourceDays = [1, 2, 3, 4, 5, 6];
  return {
    category: "clacel",
    reviewDay: 7,
    datasetRevision: "revision-a",
    sourceDays,
    series: sourceDays.map((day) => ({
      day,
      items: Array.from({ length: counts[day] ?? 20 }, (_, index) => item(day, index + 1)),
    })),
    resultHistory: history,
    random: () => 0.5,
  };
}

function historyRecord(day, wrongCounts) {
  return {
    date: `2026-09-${String(day + 5).padStart(2, "0")}`,
    category: "clacel",
    datasetRevision: "revision-a",
    day,
    questionStats: wrongCounts.map((wrongCount, index) => ({
      questionId: item(day, index + 1).questionId,
      attempts: 10,
      wrongCount,
      reasonCounts: wrongCount ? { spelling: wrongCount } : {},
    })),
  };
}

function countByDay(questions) {
  return Object.fromEntries([...questions.reduce((counts, question) => {
    const day = Number(/\/day(\d+)\//.exec(question.questionId)[1]);
    counts.set(day, (counts.get(day) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left - right));
}

test("誤答率が高い2日を9問、残りを8問にして50問選ぶ", () => {
  const history = {
    day1: historyRecord(1, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
    day4: historyRecord(4, [8, 7, 6, 5, 4, 3, 2, 1, 0, 0]),
  };
  const selected = selectReviewQuestions(fixture({ history }));
  assert.equal(selected.questions.length, 50);
  assert.equal(new Set(selected.questions.map(({ questionId }) => questionId)).size, 50);
  assert.deepEqual(countByDay(selected.questions), { 1: 9, 2: 8, 3: 8, 4: 9, 5: 8, 6: 8 });
  assert.ok(selected.questions.some(({ questionId }) => questionId.endsWith("day01/q01")));
  assert.deepEqual(selected.sourceDays, [1, 2, 3, 4, 5, 6]);
  assert.equal(selected.durationSec, 750);
});

test("履歴なし・一部履歴・同率でも不足分をランダム候補から補う", () => {
  const noHistory = selectReviewQuestions(fixture());
  assert.deepEqual(countByDay(noHistory.questions), { 1: 9, 2: 9, 3: 8, 4: 8, 5: 8, 6: 8 });

  const partial = selectReviewQuestions(fixture({ history: { day3: historyRecord(3, [5]) } }));
  assert.equal(countByDay(partial.questions)[3], 9);
  assert.equal(partial.questions.length, 50);
});

test("12問しかない日を含んでも日別上限内で50問を作る", () => {
  const selected = selectReviewQuestions(fixture({ counts: { 2: 12 } }));
  assert.equal(selected.questions.length, 50);
  assert.equal(countByDay(selected.questions)[2], 9);
});

test("50問を一意に作れない場合は開始用エラーにする", () => {
  assert.throws(
    () => selectReviewQuestions(fixture({ counts: { 6: 7 } })),
    (error) => error instanceof ReviewSelectionError && /50問/.test(error.message),
  );
});
