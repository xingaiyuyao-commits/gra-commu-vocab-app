const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureReadyReviewQuestionSet } = require("../review-question-sets");

function question(day, number) {
  return {
    questionId: `2026-09/clacel/day${String(day).padStart(2, "0")}/q${String(number).padStart(2, "0")}`,
    sentence: `Day ${day} question ${number}: ___`,
    answer: `answer-${day}-${number}`,
    base: `answer-${day}-${number}`,
    hint: "a____",
    ja: "意味",
    sentenceJa: "例文訳",
  };
}

function course() {
  const study = Array.from({ length: 6 }, (_, index) => ({
    day: index + 1,
    items: Array.from({ length: 20 }, (_unused, questionIndex) => question(index + 1, questionIndex + 1)),
  }));
  return {
    label: "Clacel",
    datasetRevision: "revision-a",
    series: [
      ...study,
      { day: 7, name: "Day 7（復習50問）", isReview: true, sourceDays: [1, 2, 3, 4, 5, 6], fixedQuestionIds: [] },
    ],
  };
}

function historyThrough(lastDay) {
  return Object.fromEntries(Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    return [`2026-09-${String(day + 5).padStart(2, "0")}:clacel`, {
      category: "clacel",
      datasetRevision: "revision-a",
      day,
      questionStats: [],
    }];
  }));
}

test("6日目の結果発表前は次の復習50問を確定しない", () => {
  const sets = {};
  const result = ensureReadyReviewQuestionSet({
    category: "clacel",
    course: course(),
    resultHistory: historyThrough(5),
    reviewQuestionSets: sets,
    random: () => 0.5,
    now: "2026-09-11T11:00:00.000Z",
  });

  assert.equal(result, null);
  assert.deepEqual(sets, {});
});

test("6日目の結果発表後に50問を一度だけ確定し、再実行でも順序を変えない", () => {
  const sets = {};
  const first = ensureReadyReviewQuestionSet({
    category: "clacel",
    course: course(),
    resultHistory: historyThrough(6),
    reviewQuestionSets: sets,
    random: () => 0.25,
    now: "2026-09-11T11:05:00.000Z",
  });
  const second = ensureReadyReviewQuestionSet({
    category: "clacel",
    course: course(),
    resultHistory: historyThrough(6),
    reviewQuestionSets: sets,
    random: () => 0.75,
    now: "2026-09-11T11:10:00.000Z",
  });

  assert.equal(first.reviewDay, 7);
  assert.equal(first.questionIds.length, 50);
  assert.equal(new Set(first.questionIds).size, 50);
  assert.deepEqual(second, first);
  assert.deepEqual(sets["7:clacel"], first);
});

test("教材に確定済み50問がある場合も6日目終了後に同じ順序で共有する", () => {
  const data = course();
  const fixed = [
    ...data.series[0].items.slice(0, 9),
    ...data.series[1].items.slice(0, 9),
    ...data.series.slice(2, 6).flatMap(({ items }) => items.slice(0, 8)),
  ].map(({ questionId }) => questionId);
  data.series.at(-1).fixedQuestionIds = fixed;

  const result = ensureReadyReviewQuestionSet({
    category: "clacel",
    course: data,
    resultHistory: historyThrough(6),
    reviewQuestionSets: {},
    random: () => { throw new Error("確定済み問題を再抽選してはいけません"); },
    now: "2026-09-11T11:05:00.000Z",
  });

  assert.deepEqual(result.questionIds, fixed);
});
