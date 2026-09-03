(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const PROJECT_START = Date.parse("2026-09-06T19:30:00+09:00");
  const WEEKLY_MISTAKE_MAX_WORDS = 420;
  const WEEKLY_CATEGORIES = new Set(["clacel", "toeic", "ielts"]);

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

  function isNonemptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function isIsoTimestamp(value) {
    if (typeof value !== "string") return false;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneHourText, zoneMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const zoneHour = Number(zoneHourText || 0);
    const zoneMinute = Number(zoneMinuteText || 0);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0
      && month >= 1 && month <= 12
      && day >= 1 && day <= monthDays[month - 1]
      && hour <= 23 && minute <= 59 && second <= 59
      && zoneHour <= 14 && zoneMinute <= 59
      && (zoneHour < 14 || zoneMinute === 0);
  }

  function isValidWeeklyWord(word) {
    return Boolean(
      word
      && typeof word === "object"
      && !Array.isArray(word)
      && isNonemptyString(word.answer)
      && Array.isArray(word.altAnswers)
      && word.altAnswers.every((answer) => typeof answer === "string")
      && isNonemptyString(word.ja)
      && isNonemptyString(word.sentence)
      && typeof word.sentenceJa === "string"
    );
  }

  function timestampBelongsToWeek(value, week) {
    if (!isIsoTimestamp(value) || !week) return false;
    const timestamp = Date.parse(value);
    return timestamp >= week.startsAt && timestamp < week.endsAt;
  }

  function isValidWeeklyRecord(record, week, validateWords = true) {
    return Boolean(
      record
      && typeof record === "object"
      && !Array.isArray(record)
      && timestampBelongsToWeek(record.at, week)
      && WEEKLY_CATEGORIES.has(record.category)
      && isNonemptyString(record.setLabel)
      && Array.isArray(record.words)
      && (!validateWords || record.words.every(isValidWeeklyWord))
    );
  }

  function parseWeeklyDocument(raw, week, validateWords = true) {
    let parsed;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.weekId !== week.id || !Array.isArray(parsed.records)
      || !parsed.records.every((record) => isValidWeeklyRecord(record, week, validateWords))) {
      return null;
    }
    return parsed;
  }

  function normalizeWeeklyWord(word) {
    if (!isValidWeeklyWord(word)) return null;
    return {
      answer: word.answer,
      altAnswers: word.altAnswers.slice(),
      ja: word.ja,
      sentence: word.sentence,
      sentenceJa: word.sentenceJa,
    };
  }

  function normalizeWeeklyRecord(record, week) {
    if (!isValidWeeklyRecord(record, week)) return null;
    return {
      at: record.at,
      category: record.category,
      setLabel: record.setLabel,
      words: record.words.map(normalizeWeeklyWord),
    };
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

  function countWeeklyMistakes(raw, date) {
    const week = getProjectWeek(date);
    if (!week) return 0;
    const parsed = parseWeeklyDocument(raw, week, false);
    if (!parsed) return 0;
    let count = 0;
    for (const record of parsed.records) count += record.words.length;
    return Math.min(count, WEEKLY_MISTAKE_MAX_WORDS);
  }

  function readWeeklyMistakes(raw, date) {
    const week = getProjectWeek(date);
    if (!week) return emptyWeeklyMistakes(week);
    const parsed = parseWeeklyDocument(raw, week);
    if (!parsed) return emptyWeeklyMistakes(week);
    const records = parsed.records.map((record) => normalizeWeeklyRecord(record, week));
    records.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    return { weekId: week.id, records: capWeeklyMistakeWords(records) };
  }

  function writeWeeklyMistakeRecord(raw, record, date) {
    const week = getProjectWeek(date);
    const state = readWeeklyMistakes(raw, date);
    if (!week || !state.weekId) return state;
    const normalized = normalizeWeeklyRecord(record, week);
    if (!normalized || normalized.words.length === 0) return state;
    const records = state.records
      .filter((existing) => existing.category !== normalized.category || existing.setLabel !== normalized.setLabel)
      .concat(normalized)
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
    countWeeklyMistakes,
    readWeeklyMistakes,
    writeWeeklyMistakeRecord,
    canCreateRoom,
    getSubmissionSummary,
    calculateResult,
  };
});
