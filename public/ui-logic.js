(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const PROJECT_START = Date.parse("2026-09-06T19:30:00+09:00");

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

  return { getStudyDay, getProjectWeek, canCreateRoom, getSubmissionSummary, calculateResult };
});
