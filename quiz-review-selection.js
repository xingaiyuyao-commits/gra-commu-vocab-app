class ReviewSelectionError extends Error {}

function shuffle(values, random) {
  const copy = values.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function matchingRecords({ category, datasetRevision, sourceDays, resultHistory }) {
  return Object.values(resultHistory || {}).filter((record) =>
    record
    && record.category === category
    && record.datasetRevision === datasetRevision
    && sourceDays.includes(Number(record.day))
    && Array.isArray(record.questionStats));
}

function aggregateStats(records) {
  const totals = new Map();
  for (const record of records) {
    for (const stat of record.questionStats) {
      if (!stat?.questionId) continue;
      const current = totals.get(stat.questionId) || { attempts: 0, wrongCount: 0 };
      current.attempts += Math.max(0, Number(stat.attempts) || 0);
      current.wrongCount += Math.max(0, Number(stat.wrongCount) || 0);
      totals.set(stat.questionId, current);
    }
  }
  return totals;
}

function averageErrorRate(items, stats) {
  const totals = items.reduce((sum, item) => {
    const stat = stats.get(item.questionId);
    return {
      attempts: sum.attempts + (stat?.attempts || 0),
      wrongCount: sum.wrongCount + (stat?.wrongCount || 0),
    };
  }, { attempts: 0, wrongCount: 0 });
  return totals.attempts > 0 ? totals.wrongCount / totals.attempts : 0;
}

function validateFixedQuestions(fixedQuestions, sourceDays) {
  if (!Array.isArray(fixedQuestions) || fixedQuestions.length !== 50) return false;
  const sourceSet = new Set(sourceDays.map(Number));
  const ids = new Set();
  const counts = new Map(sourceDays.map((day) => [Number(day), 0]));
  for (const question of fixedQuestions) {
    const questionId = String(question?.questionId || "");
    const match = /\/day(\d+)\//i.exec(questionId);
    const day = match ? Number(match[1]) : NaN;
    if (!questionId || ids.has(questionId) || !sourceSet.has(day)) return false;
    ids.add(questionId);
    counts.set(day, counts.get(day) + 1);
  }
  const quotas = [...counts.values()].sort((left, right) => left - right);
  return quotas.join(",") === "8,8,8,8,9,9";
}

function resolveFixedQuestions(fixedQuestionIds, sourceDays, series) {
  if (!Array.isArray(fixedQuestionIds) || fixedQuestionIds.length === 0) return null;
  const sourceSet = new Set(sourceDays.map(Number));
  const byId = new Map((series || [])
    .filter(({ day }) => sourceSet.has(Number(day)))
    .flatMap(({ items }) => items || [])
    .map((question) => [question.questionId, question]));
  const questions = fixedQuestionIds.map((questionId) => byId.get(questionId));
  return questions.some((question) => !question) ? [] : questions;
}

function selectReviewQuestions({
  category,
  reviewDay,
  datasetRevision,
  sourceDays,
  series,
  resultHistory,
  fixedQuestionIds,
  random = Math.random,
}) {
  if (!Array.isArray(sourceDays) || sourceDays.length !== 6) {
    throw new ReviewSelectionError(`Day ${reviewDay} の復習問題を50問作成できませんでした`);
  }
  const fixedQuestions = resolveFixedQuestions(fixedQuestionIds, sourceDays, series);
  if (fixedQuestions) {
    if (!validateFixedQuestions(fixedQuestions, sourceDays)) {
      throw new ReviewSelectionError(`Day ${reviewDay} の確定済み復習問題が不正です`);
    }
    return { questions: fixedQuestions.slice(), sourceDays: sourceDays.slice(), durationSec: 750 };
  }
  const sourceSet = new Set(sourceDays);
  const seriesByDay = new Map((series || [])
    .filter(({ day }) => sourceSet.has(Number(day)))
    .map((daySeries) => [Number(daySeries.day), daySeries]));
  const records = matchingRecords({ category, datasetRevision, sourceDays, resultHistory });
  const stats = aggregateStats(records);
  const rankedDays = sourceDays
    .map((day, sourceIndex) => ({
      day,
      sourceIndex,
      rate: averageErrorRate(seriesByDay.get(day)?.items || [], stats),
    }))
    .sort((left, right) => right.rate - left.rate || left.sourceIndex - right.sourceIndex);
  const bonusDays = new Set(rankedDays.slice(0, 2).map(({ day }) => day));

  const selected = [];
  for (const day of sourceDays) {
    const quota = bonusDays.has(day) ? 9 : 8;
    const items = seriesByDay.get(day)?.items || [];
    if (items.length < quota) {
      throw new ReviewSelectionError(`Day ${reviewDay} の復習問題を50問作成できませんでした`);
    }
    const rankedItems = items
      .map((question) => {
        const stat = stats.get(question.questionId) || { attempts: 0, wrongCount: 0 };
        return {
          question,
          wrongCount: stat.wrongCount,
          rate: stat.attempts > 0 ? stat.wrongCount / stat.attempts : 0,
          tie: random(),
        };
      })
      .sort((left, right) =>
        Number(right.wrongCount > 0) - Number(left.wrongCount > 0)
        || right.wrongCount - left.wrongCount
        || right.rate - left.rate
        || left.tie - right.tie);
    selected.push(...rankedItems.slice(0, quota).map(({ question }) => question));
  }

  if (selected.length !== 50 || new Set(selected.map(({ questionId }) => questionId)).size !== 50) {
    throw new ReviewSelectionError(`Day ${reviewDay} の復習問題を50問作成できませんでした`);
  }
  return { questions: shuffle(selected, random), sourceDays: sourceDays.slice(), durationSec: 750 };
}

module.exports = { selectReviewQuestions, ReviewSelectionError };
