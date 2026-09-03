(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const PROJECT_START = Date.parse("2026-09-06T19:30:00+09:00");
  const WEEKLY_MISTAKE_MAX_WORDS = 420;

  function getStudyDay(date) {
    const elapsed = date.getTime() - PROJECT_START;
    return elapsed < 0 ? null : Math.floor(elapsed / DAY_MS) + 1;
  }

  function getProjectWeek(date) {
    const elapsed = date.getTime() - PROJECT_START;
    if (elapsed < 0) return null;
    const weekIndex = Math.floor(elapsed / (7 * DAY_MS));
    const startsAt = PROJECT_START + weekIndex * 7 * DAY_MS;
    const endsAt = startsAt + 7 * DAY_MS;
    return {
      id: new Date(startsAt).toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }),
      startsAt,
      endsAt,
    };
  }

  function emptyWeeklyMistakes(week) {
    return { weekId: week?.id || null, records: [] };
  }

  function normalizeWeeklyWord(word) {
    if (!word || typeof word !== "object" || Array.isArray(word)) return null;
    if (word.altAnswers !== undefined && !Array.isArray(word.altAnswers)) return null;
    return {
      answer: String(word.answer || ""),
      altAnswers: (word.altAnswers || []).map((answer) => String(answer)),
      ja: String(word.ja || ""),
      sentence: String(word.sentence || ""),
      sentenceJa: String(word.sentenceJa || ""),
    };
  }

  function normalizeWeeklyRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.words)) return null;
    const words = record.words.map(normalizeWeeklyWord);
    if (words.some((word) => word === null)) return null;
    const normalized = {};
    if (typeof record.at === "string") normalized.at = record.at;
    if (typeof record.category === "string") normalized.category = record.category;
    if (typeof record.setLabel === "string") normalized.setLabel = record.setLabel;
    normalized.words = words;
    return normalized;
  }

  function capWeeklyMistakeWords(records) {
    let overflow = records.reduce((total, record) => total + record.words.length, 0) - WEEKLY_MISTAKE_MAX_WORDS;
    if (overflow <= 0) return records;
    const capped = [];
    for (const record of records) {
      if (overflow >= record.words.length) {
        overflow -= record.words.length;
        continue;
      }
      const words = overflow > 0 ? record.words.slice(overflow) : record.words;
      overflow = 0;
      if (words.length) capped.push({ ...record, words });
    }
    return capped;
  }

  function readWeeklyMistakes(raw, date) {
    const week = getProjectWeek(date);
    if (!week) return emptyWeeklyMistakes(week);
    let parsed;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return emptyWeeklyMistakes(week);
    }
    if (!parsed || typeof parsed !== "object" || parsed.weekId !== week.id || !Array.isArray(parsed.records)) {
      return emptyWeeklyMistakes(week);
    }
    const records = parsed.records.map(normalizeWeeklyRecord);
    if (records.some((record) => record === null)) return emptyWeeklyMistakes(week);
    records.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    return { weekId: week.id, records: capWeeklyMistakeWords(records) };
  }

  function writeWeeklyMistakeRecord(raw, record, date) {
    const state = readWeeklyMistakes(raw, date);
    if (!state.weekId) return state;
    const normalized = normalizeWeeklyRecord(record);
    if (!normalized || normalized.words.length === 0) return state;
    const records = [...state.records, normalized]
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    return { weekId: state.weekId, records: capWeeklyMistakeWords(records) };
  }

  function canCreateRoom(name, category) {
    return Boolean(String(name || "").trim() && category);
  }

  function normalizeAnswer(answer) {
    return String(answer || "").trim().toLowerCase();
  }

  function getSubmissionSummary(answers) {
    const unansweredNumbers = answers
      .map((answer, index) => normalizeAnswer(answer) ? null : index + 1)
      .filter((number) => number !== null);
    return {
      answered: answers.length - unansweredNumbers.length,
      unanswered: unansweredNumbers.length,
      unansweredNumbers,
      total: answers.length,
    };
  }

  function calculateResult(answers, review) {
    const score = review.reduce((total, item, index) => {
      const mine = normalizeAnswer(answers[index]);
      const accepted = [item.answer, ...(item.altAnswers || [])].map(normalizeAnswer);
      return total + (accepted.includes(mine) ? 1 : 0);
    }, 0);
    const total = review.length;
    return { score, total, accuracy: total ? Math.round((score / total) * 100) : 0 };
  }

  return {
    getStudyDay,
    getProjectWeek,
    readWeeklyMistakes,
    writeWeeklyMistakeRecord,
    canCreateRoom,
    getSubmissionSummary,
    calculateResult,
  };
});
