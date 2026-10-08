const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const { io } = require("socket.io-client");
const wordtests = require("../wordtests");
const { getStudyDateLabel } = require("../public/ui-logic");
const { ensureAllReadyReviewQuestionSets } = require("../review-question-sets");

const COURSES = ["clacel", "toeic", "ielts"];
const SOURCE_DAYS = [29, 30, 31, 32, 33, 34];
const FRIDAY = "2026-10-09T10:15:00.000Z";
const SATURDAY = "2026-10-10T10:15:00.000Z";
const PASSWORD = "day35-local-test-password";

function historyRecord(category, day = 34) {
  return {
    date: "2026-10-09", category, day,
    datasetRevision: wordtests[category].datasetRevision,
    participantCount: 1, perfectNames: [],
    questionStats: wordtests[category].series.find((series) => series.day === day).items
      .map(({ questionId }) => ({ questionId, attempts: 1, wrongCount: day === 34 ? 1 : 0,
        reasonCounts: day === 34 ? { blank: 1 } : {} })),
    updatedAt: FRIDAY,
  };
}

function day35Sets(sets) {
  return sets.filter(({ reviewDay }) => reviewDay === 35);
}

test("10月10日のDay35は3コースに一度だけ登録し、Day29〜34の未確定復習にする", () => {
  assert.equal(getStudyDateLabel(35), "10月10日");
  for (const category of COURSES) {
    const reviews = wordtests[category].series.filter(({ day }) => day === 35);
    assert.equal(reviews.length, 1, `${category}: Day35 must be registered`);
    assert.equal(wordtests[category].series.findIndex(({ day }) => day === 35),
      wordtests[category].series.findIndex(({ day }) => day === 34) + 1);
    assert.equal(reviews[0].name, "Day 35（復習50問）");
    assert.equal(reviews[0].isReview, true);
    assert.deepEqual(reviews[0].sourceDays, SOURCE_DAYS);
    assert.deepEqual(reviews[0].fixedQuestionIds, []);
    assert.deepEqual(reviews[0].items, []);
    assert.equal(wordtests[category].series.find(({ day }) => day === 34).items.length, 20);
  }
});

test("金曜最終日の確定結果がなければ、土曜になっても復習問題を生成しない", () => {
  for (const category of COURSES) {
    for (const records of [
      {},
      { previous: historyRecord(category, 33) },
      { wrongRevision: { ...historyRecord(category), datasetRevision: "other-revision" } },
      { otherCourse: historyRecord(COURSES.find((course) => course !== category)) },
    ]) {
      const sets = {};
      ensureAllReadyReviewQuestionSets({
        wordtests: { [category]: wordtests[category] }, resultHistory: records,
        reviewQuestionSets: sets, now: SATURDAY,
        random: () => { throw new Error("uncompleted course must not draw questions"); },
      });
      assert.equal(sets[`35:${category}`], undefined);
    }
  }
});

test("各コースの金曜結果確定で従来の誤答優先50問を一度だけ生成する", () => {
  const sets = {};
  const history = {};
  for (const [index, category] of COURSES.entries()) {
    history[`2026-10-09:${category}`] = historyRecord(category);
    const ready = ensureAllReadyReviewQuestionSets({
      wordtests, resultHistory: history, reviewQuestionSets: sets, now: FRIDAY, random: () => 0.25,
    });
    assert.equal(day35Sets(ready).length, index + 1);
    const record = sets[`35:${category}`];
    assert.ok(record, `${category}: Day35 was not generated`);
    assert.equal(record.questionIds.length, 50);
    assert.equal(new Set(record.questionIds).size, 50);
    assert.equal(record.readyAt, FRIDAY);
    assert.deepEqual(record.sourceDays, SOURCE_DAYS);
    const counts = SOURCE_DAYS.map((day) => record.questionIds.filter((id) => id.includes(`/day${day}/`)).length);
    assert.deepEqual(counts, [9, 8, 8, 8, 8, 9]);
    assert.equal(record.questionIds.every((id) => id.includes(`/${category}/`)), true);
  }
  const restored = JSON.parse(JSON.stringify(sets));
  ensureAllReadyReviewQuestionSets({
    wordtests, resultHistory: history, reviewQuestionSets: restored, now: SATURDAY,
    random: () => { throw new Error("persisted questions must not be redrawn"); },
  });
  assert.deepEqual(restored, sets);
});

async function startServer(t, stateFile, now) {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), OPERATOR_PASSWORD: PASSWORD,
      SCHEDULE_LINK_SECRET: "day35-local-test-link-secret",
      QUIZ_ROOM_STATE_FILE: stateFile, QUIZ_TEST_NOW_ISO: now },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(stderr || "server exited");
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) break;
    } catch {}
    if (attempt === 199) throw new Error(`server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const login = await fetch(`${base}/api/operator/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  return {
    base, stop,
    async connect(host = false) {
      const socket = io(base, { forceNew: true, reconnection: false, transports: ["websocket"],
        extraHeaders: host ? { Cookie: cookie } : undefined });
      t.after(() => socket.disconnect());
      await once(socket, "connect");
      return socket;
    },
    async ready() {
      const response = await fetch(`${base}/api/review-forms/ready`);
      assert.equal(response.status, 200);
      return day35Sets((await response.json()).reviewSets);
    },
  };
}

function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} timed out`)), 5000);
    const callback = (response) => { clearTimeout(timeout); resolve(response); };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  });
}

function stateFile(t, history = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "osh-day35-"));
  const file = path.join(directory, "quiz-rooms.json");
  fs.writeFileSync(file, JSON.stringify({ version: 4, rooms: {}, resultHistory: history, reviewQuestionSets: {} }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return file;
}

test("Day34の提出だけでは生成せず、結果発表後に各コースを確定し再起動後の土曜サイトにも同じ順で配信する", async (t) => {
  const file = stateFile(t);
  const friday = await startServer(t, file, FRIDAY);
  assert.deepEqual(await friday.ready(), []);
  for (const [index, category] of COURSES.entries()) {
    const host = await friday.connect(true);
    const student = await friday.connect();
    const created = await emit(host, "quiz:createRoom", { category, name: "運営" });
    assert.ok(created.roomCode);
    assert.ok((await emit(student, "quiz:joinRoom", { roomCode: created.roomCode, name: "テスト参加者" })).playerId);
    const sourceIndex = wordtests[category].series.findIndex(({ day }) => day === 34);
    assert.deepEqual(await emit(host, "quiz:startGame", { seriesIndex: sourceIndex }), { ok: true });
    assert.deepEqual(await emit(student, "quiz:submit", { answers: [] }), { ok: true });
    assert.equal((await friday.ready()).length, index);
    if (index === 0) {
      // A failed atomic state save must not publish an uncommitted question set.
      const backup = `${file}.backup`;
      fs.renameSync(file, backup);
      fs.mkdirSync(file);
      let failed;
      try {
        failed = await emit(host, "quiz:revealResults");
      } finally {
        fs.rmdirSync(file);
        fs.renameSync(backup, file);
      }
      assert.equal(failed.ok, false);
      assert.deepEqual(await friday.ready(), []);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).resultHistory[`2026-10-09:${category}`], undefined);
    }
    assert.deepEqual(await emit(host, "quiz:revealResults"), { ok: true });
    assert.equal((await friday.ready()).length, index + 1);
  }
  const ready = await friday.ready();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const category of COURSES) {
    assert.equal(saved.resultHistory[`2026-10-09:${category}`].day, 34);
    assert.equal(saved.reviewQuestionSets[`35:${category}`].questionIds.length, 50);
  }
  await friday.stop();
  const saturday = await startServer(t, file, SATURDAY);
  assert.deepEqual(await saturday.ready(), ready);
  for (const category of COURSES) {
    const host = await saturday.connect(true);
    const created = await emit(host, "quiz:createRoom", { category, name: "運営", scheduledDate: "2026-10-10" });
    assert.ok(created.roomCode);
    const reviewIndex = wordtests[category].series.findIndex(({ day }) => day === 35);
    assert.equal(created.selectedSeriesIndex, reviewIndex);
    assert.equal(created.seriesMeta[reviewIndex].timeLimitSec, 750);
    assert.equal(created.seriesMeta[reviewIndex].count, 50);
    assert.deepEqual(await emit(host, "quiz:startGame", { seriesIndex: reviewIndex }), { ok: true });
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(state.rooms[created.roomCode].questions.map(({ questionId }) => questionId),
      ready.find((record) => record.category === category).questionIds);
    assert.deepEqual(state.resultHistory, saved.resultHistory);
  }
});

test("再起動時も金曜結果のあるコースだけを回収し、復習50問の確定を永続化する", async (t) => {
  const file = stateFile(t, { "2026-10-09:toeic": historyRecord("toeic") });
  const first = await startServer(t, file, SATURDAY);
  const ready = await first.ready();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].category, "toeic");
  assert.equal(ready[0].questionIds.length, 50);
  assert.equal(ready[0].questionIds.filter((id) => id.includes("/day34/")).length, 9);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).reviewQuestionSets["35:toeic"].questionIds, ready[0].questionIds);
  await first.stop();
  const second = await startServer(t, file, SATURDAY);
  assert.deepEqual(await second.ready(), ready);
});
