(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY1_UTC = Date.UTC(2026, 8, 1);

  function getStudyDay(date) {
    const currentUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const elapsed = Math.round((currentUtc - DAY1_UTC) / 86400000);
    return elapsed < 0 ? null : elapsed + 1;
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

  return { getStudyDay, canCreateRoom, getSubmissionSummary, calculateResult };
});
