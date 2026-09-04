// 承認済みPDFから生成した固定問題データ。実行中のブラウザ編集は行わない。
const TRIALS = require("./data/wordtests/trial.json");

const COURSE_DATA = {
  clacel: require("./data/wordtests/clacel-2026-09.json"),
  toeic: require("./data/wordtests/toeic-2026-09.json"),
  ielts: require("./data/wordtests/ielts-2026-09.json"),
};

const REVIEW_DAYS = [
  { day: 7, sourceDays: [1, 2, 3, 4, 5, 6] },
  { day: 14, sourceDays: [8, 9, 10, 11, 12, 13] },
  { day: 21, sourceDays: [15, 16, 17, 18, 19, 20] },
];

function withReviewDays(studySeries) {
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
    series: [TRIALS[category], ...withReviewDays(data.series)],
  },
]));
