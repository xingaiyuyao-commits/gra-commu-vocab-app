// 承認済みPDFから生成した固定問題データ。実行中のブラウザ編集は行わない。
const TRIALS = require("./data/wordtests/trial.json");

const COURSE_DATA = {
  clacel: require("./data/wordtests/clacel-2026-09.json"),
  toeic: require("./data/wordtests/toeic-2026-09.json"),
  ielts: require("./data/wordtests/ielts-2026-09.json"),
};

const FIXED_REVIEW_SETS = require("./data/wordtests/review-2026-09.json");

const REVIEW_DAYS = [
  { day: 7, sourceDays: [1, 2, 3, 4, 5, 6] },
  { day: 14, sourceDays: [8, 9, 10, 11, 12, 13] },
  { day: 21, sourceDays: [15, 16, 17, 18, 19, 20] },
];

function fixedReviewQuestionIds(category, datasetRevision, reviewDay, sourceDays, studySeries) {
  const fixed = FIXED_REVIEW_SETS.days?.[String(reviewDay)]?.courses?.[category];
  if (!fixed) return [];
  if (fixed.datasetRevision !== datasetRevision) {
    throw new Error(`${category} Day ${reviewDay} の確定済み復習問題は教材版と一致しません`);
  }
  const sourceSet = new Set(sourceDays);
  const byId = new Map(studySeries
    .filter(({ day }) => sourceSet.has(day))
    .flatMap(({ items }) => items)
    .map((item) => [item.questionId, item]));
  const questionIds = Array.isArray(fixed.questionIds) ? fixed.questionIds : [];
  const items = questionIds.map((questionId) => byId.get(questionId));
  if (items.length !== 50 || items.some((item) => !item) || new Set(questionIds).size !== 50) {
    throw new Error(`${category} Day ${reviewDay} の確定済み復習問題が不正です`);
  }
  return questionIds;
}

function withReviewDays(category, data) {
  const studySeries = data.series;
  const reviewsByDay = new Map(REVIEW_DAYS.map((review) => [review.day, review]));
  const studyByDay = new Map(studySeries.map((series) => [series.day, series]));
  const lastDay = Math.max(...studyByDay.keys());
  const series = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const review = reviewsByDay.get(day);
    if (review) {
      series.push({
        name: `Day ${day}（復習50問）`,
        day,
        isReview: true,
        sourceDays: review.sourceDays,
        fixedQuestionIds: fixedReviewQuestionIds(category, data.datasetRevision, day, review.sourceDays, studySeries),
        items: [],
      });
    }
    const study = studyByDay.get(day);
    if (study) series.push(study);
  }
  return series;
}

module.exports = Object.fromEntries(Object.entries(COURSE_DATA).map(([category, data]) => [
  category,
  {
    ...data,
    series: [TRIALS[category], ...withReviewDays(category, data)],
  },
]));
