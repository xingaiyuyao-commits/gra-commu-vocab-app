const { selectReviewQuestions } = require("./quiz-review-selection");

function reviewQuestionSetKey(reviewDay, category) {
  return `${Number(reviewDay)}:${String(category || "").toLowerCase()}`;
}

function finalSourceDayHasResults({ category, datasetRevision, finalSourceDay, resultHistory }) {
  return Object.values(resultHistory || {}).some((record) =>
    record
    && record.category === category
    && record.datasetRevision === datasetRevision
    && Number(record.day) === Number(finalSourceDay)
    && Array.isArray(record.questionStats));
}

function ensureReadyReviewQuestionSet({
  category,
  course,
  resultHistory,
  reviewQuestionSets,
  reviewDay,
  random = Math.random,
  now = new Date().toISOString(),
}) {
  const reviewSeries = (course?.series || []).filter((series) =>
    series?.isReview === true
    && (!reviewDay || Number(series.day) === Number(reviewDay)));

  for (const series of reviewSeries) {
    const key = reviewQuestionSetKey(series.day, category);
    if (reviewQuestionSets[key]) return reviewQuestionSets[key];
    const sourceDays = Array.isArray(series.sourceDays) ? series.sourceDays.map(Number) : [];
    const finalSourceDay = sourceDays.at(-1);
    if (!finalSourceDayHasResults({
      category,
      datasetRevision: course.datasetRevision,
      finalSourceDay,
      resultHistory,
    })) continue;

    const selected = selectReviewQuestions({
      category,
      reviewDay: series.day,
      datasetRevision: course.datasetRevision,
      sourceDays,
      series: course.series,
      resultHistory,
      fixedQuestionIds: series.fixedQuestionIds,
      random,
    });
    const record = {
      reviewDay: Number(series.day),
      category,
      datasetRevision: course.datasetRevision,
      sourceDays,
      questionIds: selected.questions.map(({ questionId }) => questionId),
      readyAt: now,
    };
    reviewQuestionSets[key] = record;
    return record;
  }
  return null;
}

function ensureAllReadyReviewQuestionSets({ wordtests, resultHistory, reviewQuestionSets, random = Math.random, now }) {
  const ready = [];
  for (const [category, course] of Object.entries(wordtests || {})) {
    for (const series of (course?.series || []).filter(({ isReview }) => isReview === true)) {
      const record = ensureReadyReviewQuestionSet({
        category,
        course,
        resultHistory,
        reviewQuestionSets,
        reviewDay: series.day,
        random,
        now,
      });
      if (record) ready.push(record);
    }
  }
  return ready;
}

module.exports = {
  ensureAllReadyReviewQuestionSets,
  ensureReadyReviewQuestionSet,
  reviewQuestionSetKey,
};
