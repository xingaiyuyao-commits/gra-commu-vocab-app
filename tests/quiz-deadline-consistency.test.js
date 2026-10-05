const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { loadQuizPage } = require('./helpers/loadQuizPage');
const savedResults = require('../public/saved-results');
const wordtests = require('../wordtests');

const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const ack = (socket, event, body) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`${event} timeout`)), 5000);
  socket.emit(event, body, response => { clearTimeout(timer); resolve(response); });
});
const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`${event} timeout`)), 5000);
  socket.once(event, data => { clearTimeout(timer); resolve(data); });
});
const items = wordtests.clacel.series.find(series => series.day === 29).items;
const correct = items.map(item => item.answer);
function player(name, draftAnswers = []) {
  return { name, sessionToken: `synthetic-${name}`, submittedAt: null, submissionKind: null,
    draftAnswers, draftRevision: 0, score: 0, wrongQuestionIndexes: [], wrongAnswerReasons: {} };
}
async function fixture(t, { duration = 2200, draft = [], questions = items, delayedTimeout = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-deadline-test-'));
  const stateFile = path.join(dir, 'state.json');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const endsAt = Date.now() + duration;
  fs.writeFileSync(stateFile, JSON.stringify({ version: 4, rooms: { TEST: {
    host: 'host', category: 'clacel', phase: 'playing', players: {
      host: player('host'), p: player('learner', draft),
    }, questions, startedAt: endsAt - 300000, endsAt, setLabel: 'Synthetic quiz', day: 29,
    datasetRevision: wordtests.clacel.datasetRevision, isTrial: false, results: null,
  } }, resultHistory: {} }));
  const preload = path.join(dir, 'delay-timeout.cjs');
  if (delayedTimeout) fs.writeFileSync(preload, `const original = global.setTimeout; global.setTimeout = (fn, ms, ...args) => original(fn, ms + (String(fn).includes('quizForceFinish') ? 700 : 0), ...args);`);
  const child = spawn(process.execPath, [...(delayedTimeout ? ['--require', preload] : []), 'server.js'], { cwd: path.join(__dirname, '..'), env: {
    ...process.env, PORT: String(port), QUIZ_ROOM_STATE_FILE: stateFile,
    OPERATOR_PASSWORD: 'synthetic-password', RESULTS_ADMIN_PASSWORD: '',
    RAILWAY_ENVIRONMENT_ID: '', RAILWAY_SERVICE_ID: '', RAILWAY_PROJECT_ID: '',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const sockets = [];
  const pages = [];
  t.after(async () => {
    pages.forEach(page => page.close());
    sockets.forEach(socket => socket.disconnect());
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (child.exitCode !== null) throw Error(stderr);
    await delay(20);
  }
  const login = await fetch(`${base}/api/operator/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function connect(asHost = false, rejoin = true) {
    const socket = io(base, { reconnection: false, forceNew: true, transports: ['websocket'],
      extraHeaders: asHost ? { Cookie: cookie } : undefined });
    sockets.push(socket);
    await once(socket, 'connect');
    if (rejoin) assert.equal((await ack(socket, 'quiz:rejoin', { roomCode: 'TEST',
      playerId: asHost ? 'host' : 'p', sessionToken: asHost ? 'synthetic-host' : 'synthetic-learner' })).ok, true);
    return socket;
  }
  const host = await connect(true);
  const learner = await connect();
  function readPlayer() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).rooms.TEST.players.p; }
  async function reveal(socket = learner) {
    const event = once(socket, 'quiz:results');
    const response = await new Promise(resolve => host.emit('quiz:revealResults', resolve));
    assert.equal(response.ok, true);
    return event;
  }
  function pageFor(socket = learner, initialAnswers = draft, revision = 0) {
    const answers = questions.map((_, i) => initialAnswers[i] || '');
    const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: {
      quizPlayerId: 'p', quizSession: JSON.stringify({ roomCode: 'TEST', category: 'clacel', playerId: 'p', sessionToken: 'synthetic-learner' }),
      quizAnswers: JSON.stringify({ roomCode: 'TEST', answers, idx: 17, revision, endsAt }),
    } });
    pages.push(page);
    // Run the real DOM code, with its actual payloads bridged to the local Socket.IO server.
    const originalEmit = page.fakeSocket.emit;
    page.fakeSocket.emit = (event, payload, cb) => {
      originalEmit(event, payload, cb);
      if (typeof cb === 'function') socket.emit(event, payload, cb);
      else socket.emit(event, payload);
      return page.fakeSocket;
    };
    for (const event of ['quiz:timeExpired', 'quiz:results', 'quiz:submitProgress']) {
      socket.on(event, data => page.fireSocketEvent(event, data));
    }
    page.fireSocketEvent('connect');
    return page;
  }
  return { endsAt, host, learner, connect, reveal, pageFor, readPlayer, stateFile };
}
async function readyPage(page) {
  for (let i = 0; i < 100; i++) {
    if (page.document.getElementById('screen-quiz').classList.contains('active')) return;
    await delay(5);
  }
  throw Error('DOM quiz did not resume');
}
function input(page, answer) {
  const el = page.document.getElementById('answer');
  el.value = answer;
  el.dispatchEvent(new page.window.Event('input', { bubbles: true }));
}

for (const makeCorrect of [true, false]) {
  test(`real DOM last-200ms ${makeCorrect ? 'correction' : 'deletion'} is immediately saved and timeout agrees with result`, async t => {
    const draft = [...correct];
    draft[17] = makeCorrect ? '' : correct[17];
    const f = await fixture(t, { draft });
    const page = f.pageFor();
    await readyPage(page);
    const expired = once(f.learner, 'quiz:timeExpired');
    await delay(f.endsAt - Date.now() - 200);
    const typedAt = Date.now();
    input(page, makeCorrect ? correct[17] : '');
    const sent = page.emitted.filter(entry => entry.event === 'quiz:saveDraft').at(-1);
    assert.ok(sent, 'input event sends without waiting for 750ms timer');
    assert.equal(sent.payload.answers[17], makeCorrect ? correct[17] : '');
    assert.ok(typedAt < f.endsAt && f.endsAt - typedAt < 350);
    await expired;
    const results = await f.reveal();
    const expected = makeCorrect ? 20 : 19;
    assert.equal(f.readPlayer().score, expected);
    assert.equal(f.readPlayer().submissionKind, 'timeout');
    assert.equal(results.personalResult.score, expected);
    assert.equal(page.document.getElementById('personal-score').textContent, `${expected} / 20点`);
    assert.equal(results.perfect.length, makeCorrect ? 1 : 0);
    assert.equal(page.document.querySelectorAll('#review .review-item').length, makeCorrect ? 0 : 1);
    assert.equal(savedResults.find(page.window.localStorage.getItem(savedResults.STORAGE_KEY), 'TEST').personalResult.score, expected);
  });
}

test('after-cutoff network-delayed answers cannot change authoritative score; UI does not claim perfect', async t => {
  const draft = [...correct]; draft[17] = '';
  const f = await fixture(t, { duration: 1000, draft });
  const expired = once(f.learner, 'quiz:timeExpired');
  await expired;
  assert.equal((await ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 2, endsAt: f.endsAt })).ok, false);
  for (const automatic of [false, true]) {
    assert.equal((await ack(f.learner, 'quiz:submit', { answers: correct, automatic, revision: 2, endsAt: f.endsAt })).ok, true);
  }
  const result = await f.reveal();
  assert.equal(result.personalResult.score, 19);
  assert.deepEqual(result.personalResult.wrongQuestionIndexes, [17]);
  const page = f.pageFor(f.learner, correct, 2);
  for (let i = 0; i < 100 && !page.document.getElementById('screen-results').classList.contains('active'); i++) await delay(5);
  assert.equal(page.document.getElementById('personal-score').textContent, '19 / 20点');
  assert.equal(page.document.getElementById('no-perfect').style.display, '');
  assert.equal(page.document.querySelectorAll('#review .review-item').length, 1);
  assert.match(page.document.getElementById('authoritative-result-note').textContent, /サーバー/);
  assert.deepEqual(f.readPlayer().draftAnswers, []);
});

test('out-of-order drafts, stale submit, duplicate clicks and result replay are idempotent', async t => {
  const f = await fixture(t, { duration: 5000 });
  const wrong = correct.map(() => 'incorrect');
  assert.equal((await ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 3, endsAt: f.endsAt })).ok, true);
  for (const revision of [2, 3, undefined]) {
    const stale = await ack(f.learner, 'quiz:saveDraft', { answers: wrong, revision, endsAt: f.endsAt });
    assert.equal(stale.stale, true);
  }
  assert.equal((await ack(f.learner, 'quiz:submit', { answers: wrong, revision: 2, endsAt: f.endsAt })).ok, true);
  const submittedAt = f.readPlayer().submittedAt;
  assert.equal((await ack(f.learner, 'quiz:submit', { answers: wrong, revision: 4, endsAt: f.endsAt })).ok, true);
  assert.equal(f.readPlayer().submittedAt, submittedAt);
  assert.equal(f.readPlayer().score, 20);
  const hostResults = once(f.host, 'quiz:results');
  const result = await f.reveal();
  assert.equal(result.personalResult.score, 20);
  assert.equal((await hostResults).personalResult, undefined, 'host does not receive learner private outcome');
  assert.equal((await ack(f.learner, 'quiz:submit', { answers: wrong, revision: 10, endsAt: f.endsAt })).ok, true);
  const stored = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(stored.rooms.TEST.players.host.submittedAt, null);
  assert.equal(Object.values(stored.resultHistory)[0].participantCount, 1);
  assert.equal(JSON.stringify(stored.resultHistory).includes('personalResult'), false);
  assert.equal(JSON.stringify(stored.rooms.TEST.results).includes('personalResult'), false);
});

test('host and unattached spectator cannot save or submit; expired round payload cannot edit current draft', async t => {
  const f = await fixture(t, { duration: 5000 });
  const spectator = await f.connect(false, false);
  for (const socket of [f.host, spectator]) {
    for (const event of ['quiz:saveDraft', 'quiz:submit']) {
      assert.equal((await ack(socket, event, { answers: correct, revision: 1, endsAt: f.endsAt })).ok, false);
    }
  }
  for (const event of ['quiz:saveDraft', 'quiz:submit']) {
    assert.equal((await ack(f.learner, event, { answers: correct, revision: 100, endsAt: f.endsAt - 1 })).ok, false);
  }
  assert.equal(f.readPlayer().submittedAt, null);
  assert.deepEqual(f.readPlayer().draftAnswers, []);
});

test('reconnect selects newest accepted revision and rejects prior-connection stale updates', async t => {
  const f = await fixture(t, { duration: 5000 });
  await ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 3, endsAt: f.endsAt });
  const fresh = await f.connect();
  const state = await ack(fresh, 'quiz:rejoin', { roomCode: 'TEST', playerId: 'p', sessionToken: 'synthetic-learner' });
  assert.equal(state.draftRevision, 3);
  const old = correct.map(() => 'old');
  const page = f.pageFor(fresh, old, 2);
  await readyPage(page);
  assert.equal(page.document.getElementById('answer').value, correct[17]);
  input(page, `${correct[17]} `);
  page.window.eval('sendDraftNow()');
  const acceptedDraft = page.emitted.filter(entry => entry.event === 'quiz:saveDraft').at(-1).payload;
  assert.equal((await ack(fresh, 'quiz:saveDraft', acceptedDraft)).ok, true);
  assert.equal(f.readPlayer().draftRevision, 4);
  assert.equal((await ack(f.learner, 'quiz:saveDraft', { answers: old, revision: 3, endsAt: f.endsAt })).stale, true);
  page.document.getElementById('btn-confirm-submit').click();
  page.document.getElementById('btn-confirm-submit').click();
  assert.equal(page.emitted.filter(entry => entry.event === 'quiz:submit').length, 1);
  await delay(30);
  const results = await f.reveal(fresh);
  assert.equal(results.personalResult.score, 20);
});

test('cached authoritative outcome survives reopening even if local answers differ', () => {
  const at = new Date().toISOString();
  const record = savedResults.upsert(null, { roomCode: 'TEST', category: 'clacel', resultAt: at,
    answers: correct, review: items, playerId: 'p', localAnswerRevision: 2,
    personalResult: { score: 19, total: 20, wrongQuestionIndexes: [17], answerRevision: 1, submissionKind: 'timeout' } });
  assert.equal(record.ok, true);
  const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: { [savedResults.STORAGE_KEY]: record.raw } });
  try {
    assert.equal(page.document.getElementById('personal-score').textContent, '19 / 20点');
    assert.equal(page.document.querySelectorAll('#review .review-item').length, 1);
  } finally { page.close(); }
});

test('reconnect discards previous-round pending submission and allows the current round', () => {
  const endsAt = Date.now() + 60000;
  const page = loadQuizPage({ url: 'http://localhost/quiz.html?room=TEST', storedValues: {
    quizPlayerId: 'p', quizSession: JSON.stringify({ roomCode: 'TEST', category: 'clacel', playerId: 'p', sessionToken: 'token' }),
    quizPendingSubmission: JSON.stringify({ roomCode: 'TEST', answers: correct, revision: 20, endsAt: endsAt - 300000 }),
  } });
  try {
    page.fireSocketEvent('connect');
    page.emitted.find(entry => entry.event === 'quiz:rejoin').cb({ ok: true, category: 'clacel', phase: 'playing',
      isHost: false, submitted: false, questions: items, draftAnswers: [], draftRevision: 0,
      endsAt, remainingMs: 60000, totalCount: 1, submittedCount: 0 });
    assert.equal(page.emitted.filter(entry => entry.event === 'quiz:submit').length, 0);
    assert.equal(page.window.localStorage.getItem('quizPendingSubmission'), null);
    assert.equal(page.document.getElementById('screen-quiz').classList.contains('active'), true);
    assert.equal(page.document.getElementById('answer').disabled, false);
  } finally { page.close(); }
});

test('equal multi-tab revisions cannot hide a mismatch with the authoritative outcome', () => {
  const page = loadQuizPage();
  try {
    page.window.eval('draftRevision = 6; answers = ["alpha"];');
    page.fireSocketEvent('quiz:results', { perfect: [], review: [{ answer: 'alpha', sentence: 'Say ___.', ja: 'synthetic' }],
      personalResult: { score: 0, total: 1, wrongQuestionIndexes: [0], answerRevision: 6 } });
    assert.equal(page.document.getElementById('personal-score').textContent, '0 / 1点');
    assert.equal(page.document.getElementById('authoritative-result-note').hidden, false);
    assert.match(page.document.querySelector('.review-mine').textContent, /この端末の入力/);
  } finally { page.close(); }
});

for (const automatic of [false, true]) {
  test(`server cutoff rejects new answers even when timeout callback is delayed (${automatic ? 'automatic' : 'manual'})`, async t => {
    const draft = [...correct]; draft[17] = '';
    const f = await fixture(t, { duration: 1200, draft, delayedTimeout: true });
    await delay(f.endsAt - Date.now() + 20);
    assert.equal(f.readPlayer().submittedAt, null, 'timeout callback has deliberately not run');
    const late = await ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 1, endsAt: f.endsAt });
    assert.equal(late.ok, false);
    assert.equal((await ack(f.learner, 'quiz:submit', { answers: correct, revision: 2, endsAt: f.endsAt, automatic })).ok, true);
    assert.equal(f.readPlayer().score, 19);
    assert.equal(f.readPlayer().submissionKind, 'timeout');
    const submittedAt = f.readPlayer().submittedAt;
    await delay(750);
    assert.equal(f.readPlayer().submittedAt, submittedAt);
  });
}

test('delayed submit callbacks cannot overwrite timeout, revealed result or a later round', () => {
  const page = loadQuizPage({ storedValues: { quizPlayerId: 'p' } });
  try {
    page.window.eval('currentRoomCode = "TEST";');
    const endsAt = Date.now() + 5000;
    page.fireSocketEvent('quiz:started', { setLabel: 'Test', questions: items, total: 20, endsAt, remainingMs: 5000 });
    page.window.eval('submitQuiz(true)');
    const submit = page.emitted.find(entry => entry.event === 'quiz:submit');
    page.fireSocketEvent('quiz:timeExpired', { submitted: 1, total: 1 });
    submit.cb({ ok: false, remainingMs: 2000, error: 'Delayed early-automatic response' });
    assert.equal(page.document.getElementById('screen-waiting').classList.contains('active'), true);
    assert.equal(page.document.getElementById('answer').disabled, true);
    page.fireSocketEvent('quiz:results', { perfect: [], review: items,
      personalResult: { score: 0, total: 20, wrongQuestionIndexes: items.map((_, i) => i), answerRevision: 0 } });
    submit.cb({ ok: false, remainingMs: 2000 });
    assert.equal(page.document.getElementById('screen-results').classList.contains('active'), true);
    page.fireSocketEvent('quiz:started', { setLabel: 'Next', questions: items, total: 20, endsAt: endsAt + 300000, remainingMs: 300000 });
    submit.cb({ ok: false, remainingMs: 2000 });
    assert.equal(page.document.getElementById('quiz-timer').textContent, '残り時間 5:00');
  } finally { page.close(); }
});

test('failed batch persistence never ACKs durability or finalizes an older draft; recovery keeps the on-time snapshot', async t => {
  const draft = [...correct]; draft[17] = '';
  const f = await fixture(t, { duration: 1500, draft });
  const backup = `${f.stateFile}.backup`;
  fs.renameSync(f.stateFile, backup);
  fs.mkdirSync(f.stateFile); // Force atomic rename to fail, only in this synthetic fixture.
  const response = await ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 1, endsAt: f.endsAt });
  assert.equal(response.ok, false);
  assert.equal((await ack(f.learner, 'quiz:submit', { answers: correct, revision: 1, endsAt: f.endsAt })).ok, false);
  await delay(f.endsAt - Date.now() + 50);
  const state = await ack(f.learner, 'quiz:rejoin', { roomCode: 'TEST', playerId: 'p', sessionToken: 'synthetic-learner' });
  assert.equal(state.submitted, false, 'storage failure cannot finalize the stale draft');
  fs.rmdirSync(f.stateFile);
  fs.renameSync(backup, f.stateFile);
  for (let i = 0; i < 100 && f.readPlayer().submittedAt === null; i++) await delay(20);
  assert.equal(f.readPlayer().submissionKind, 'timeout');
  assert.equal(f.readPlayer().score, 20);
  assert.equal(f.readPlayer().draftRevision, 1);
  assert.deepEqual(f.readPlayer().draftAnswers, []);
});

test('batched on-time draft is flushed before manual submit and acknowledged data exists on disk', async t => {
  const f = await fixture(t, { duration: 5000 });
  const draftAck = ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 3, endsAt: f.endsAt });
  const submitted = await ack(f.learner, 'quiz:submit', { answers: correct.map(() => ''), revision: 2, endsAt: f.endsAt });
  assert.equal((await draftAck).ok, true);
  assert.equal(submitted.ok, true);
  assert.equal(f.readPlayer().score, 20);
  assert.equal(f.readPlayer().draftRevision, 3);
});

test('pending batch cannot bleed into a cancelled and restarted round', async t => {
  const f = await fixture(t, { duration: 5000 });
  const oldDraft = ack(f.learner, 'quiz:saveDraft', { answers: correct, revision: 100, endsAt: f.endsAt });
  assert.equal((await new Promise(resolve => f.host.emit('quiz:cancelGame', resolve))).ok, true);
  const nextRound = once(f.learner, 'quiz:started');
  assert.equal((await ack(f.host, 'quiz:startGame', { seriesIndex: 1 })).ok, true);
  const started = await nextRound;
  assert.notEqual(started.endsAt, f.endsAt);
  const blank = started.questions.map(() => '');
  assert.equal((await ack(f.learner, 'quiz:saveDraft', { answers: blank, revision: 1, endsAt: started.endsAt })).ok, true);
  await oldDraft; // It may already have flushed before cancellation; either way it cannot carry forward.
  assert.equal(f.readPlayer().draftRevision, 1);
  assert.deepEqual(f.readPlayer().draftAnswers, blank);
  assert.equal(f.readPlayer().submittedAt, null);
});
