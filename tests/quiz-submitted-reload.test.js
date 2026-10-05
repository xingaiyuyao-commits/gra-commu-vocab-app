const test = require('node:test');
const assert = require('node:assert/strict');
const { loadQuizPage } = require('./helpers/loadQuizPage');
const wordtests = require('../wordtests');
const savedResults = require('../public/saved-results');

for (const category of ['clacel', 'toeic', 'ielts']) {
  for (const isReview of [false, true]) {
    const total = isReview ? 50 : 20;
    for (const score of [total, total - 1]) {
    test(`${category}: submitted reload restores timer, answers, authoritative ${score}/${total} and reusable result`, () => {
      const items = isReview
        ? wordtests[category].series.filter(series => series.day >= 1 && series.day <= 6).flatMap(series => series.items).slice(0, 50)
        : wordtests[category].series.find(series => series.day === 30).items;
      const answers = items.map(item => item.answer);
      if (score < total) answers[8] = 'synthetic wrong answer';
      const endsAt = Date.now() + 180000;
      const storedValues = {
        quizPlayerId: 'p',
        quizSession: JSON.stringify({ roomCode: 'TEST', category, playerId: 'p', sessionToken: 'synthetic' }),
        quizAnswers: JSON.stringify({ roomCode: 'TEST', answers, idx: total - 1, revision: total, endsAt }),
      };
      const page = loadQuizPage({ url: `http://localhost/quiz.html?room=TEST&cat=${category}`, storedValues });
      let reopened;
      try {
        page.fireSocketEvent('connect');
        page.emitted.find(entry => entry.event === 'quiz:rejoin').cb({ ok: true, isHost: false, category,
          phase: 'playing', submitted: true, autoSubmitted: false, setLabel: 'Day 30',
          questions: items, total, endsAt, remainingMs: 180000, submittedCount: 1, totalCount: 2 });
        assert.equal(page.document.getElementById('waiting-timer').textContent, '残り時間 3:00');
        assert.deepEqual(JSON.parse(page.window.eval('JSON.stringify(answers)')), answers);
        assert.equal(page.emitted.filter(entry => ['quiz:submit', 'quiz:saveDraft'].includes(entry.event)).length, 0);
        page.fireSocketEvent('quiz:results', { resultAt: new Date().toISOString(), setLabel: 'Day 30',
          perfect: score === total ? [{ id: 'p', name: 'Synthetic' }] : [], review: items, isReview, leaderboard: isReview ? [{ rank: 1, score, total, players: [{ id: 'p', name: 'Synthetic' }] }] : [],
          personalResult: { score, total, wrongQuestionIndexes: score === total ? [] : [8], answerRevision: total, submissionKind: 'manual' } });
        assert.equal(page.document.getElementById('personal-score').textContent, `${score} / ${total}点`);
        assert.equal(page.document.querySelectorAll('#review .review-item').length, total - score);
        assert.equal(page.document.getElementById('correct-summary').textContent, `正解だった単語 ${score}語`);
        if (isReview) assert.equal(page.document.getElementById('perfect-count').textContent, '🏆 復習日 TOP 5');
        const raw = page.window.localStorage.getItem(savedResults.STORAGE_KEY);
        const record = savedResults.find(raw, 'TEST');
        assert.ok(record, 'seven-day result is stored');
        assert.deepEqual(record.answers, answers);
        assert.equal(record.personalResult.score, score);
        assert.match(page.document.getElementById('results-save-status').textContent, /7日間/);
        reopened = loadQuizPage({ url: `http://localhost/quiz.html?room=TEST&cat=${category}`, storedValues: { [savedResults.STORAGE_KEY]: raw } });
        assert.equal(reopened.document.getElementById('personal-score').textContent, `${score} / ${total}点`);
        if (score < total) {
          reopened.document.getElementById('btn-retest').click();
          assert.equal(reopened.document.getElementById('retest-num').textContent, '1 / 1');
        }
      } finally { page.close(); reopened?.close(); }
    });
    }
  }
}

test('submitted reload without local answers still uses authoritative outcome and can retain it', () => {
  const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: {
    quizPlayerId: 'p', quizSession: JSON.stringify({ roomCode: 'TEST', category: 'clacel', playerId: 'p', sessionToken: 'synthetic' }),
  } });
  try {
    const questions = [{ sentence: 'Say ___.', answer: 'alpha', ja: 'synthetic' }];
    page.fireSocketEvent('connect');
    page.emitted.find(entry => entry.event === 'quiz:rejoin').cb({ ok: true, isHost: false, category: 'clacel', phase: 'playing',
      submitted: true, endsAt: Date.now() + 60000, remainingMs: 60000, questions, submittedCount: 1, totalCount: 1 });
    page.fireSocketEvent('quiz:results', { resultAt: new Date().toISOString(), perfect: [{ id: 'p', name: 'Synthetic' }], review: questions,
      personalResult: { score: 1, total: 1, wrongQuestionIndexes: [], answerRevision: 1 } });
    assert.equal(page.document.getElementById('personal-score').textContent, '1 / 1点');
    assert.equal(page.document.querySelectorAll('#review .review-item').length, 0);
    assert.equal(savedResults.find(page.window.localStorage.getItem(savedResults.STORAGE_KEY), 'TEST').personalResult.score, 1);
    assert.equal(page.document.getElementById('authoritative-result-note').hidden, false);
  } finally { page.close(); }
});

test('legacy browser cache keeps its old local grading rule, explicitly labeled as a reference', () => {
  const record = { roomCode: 'TEST', category: 'clacel', resultAt: new Date().toISOString(),
    perfect: [], review: [{ sentence: 'Say ___.', answer: 'in person', ja: 'synthetic' }],
    answers: ['in\u3000person'], playerId: 'p' };
  const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: {
    [savedResults.STORAGE_KEY]: JSON.stringify({ version: 1, records: [record] }),
  } });
  try {
    assert.equal(page.document.getElementById('personal-score').textContent, '参考 0 / 1点');
    assert.equal(page.document.querySelectorAll('#review .review-item').length, 1);
    assert.match(page.document.getElementById('authoritative-result-note').textContent, /参考値/);
  } finally { page.close(); }
});

test('legacy review leaderboard score remains authoritative after cached result restore', () => {
  const record = { roomCode: 'TEST', category: 'clacel', resultAt: new Date().toISOString(),
    perfect: [], isReview: true, leaderboard: [{ rank: 1, score: 1, total: 1, players: [{ id: 'p', name: 'Synthetic' }] }],
    review: [{ sentence: 'Say ___.', answer: 'alpha', ja: 'synthetic' }], answers: [''], playerId: 'p' };
  const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: {
    [savedResults.STORAGE_KEY]: JSON.stringify({ version: 1, records: [record] }),
  } });
  try {
    assert.equal(page.document.getElementById('personal-score').textContent, '1 / 1点');
    assert.equal(page.document.querySelectorAll('#review .review-item').length, 0);
  } finally { page.close(); }
});
