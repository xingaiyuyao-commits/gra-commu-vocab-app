"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { io } = require("socket.io-client");
const { startChrome, stopProcess, delay } = require("./helpers/chromiumCdp");
const oracle = require("./fixtures/pdf-days29-34-2026-10.json");

// Deliberately do not require wordtests, read data/wordtests, or derive expected
// answers from quiz:started/results. All expected text comes from the PDFs.
const CATEGORIES = ["clacel", "toeic", "ielts"];
const DAYS = [29, 30, 31, 32, 33, 34];
const REGRESSION_ID = "2026-10/clacel/day33/q16";
const SAVED_RESULTS_KEY = "oshQuizSavedResultsV1";

function displayMeaning(row) {
  // This one PDF includes the headword as a label before its Japanese meaning.
  // The site intentionally displays only the meaning; the oracle retains the PDF.
  return row.questionId === "2026-10/ielts/day34/q12"
    ? row.ja.replace(/^on the threshold of：\s*/, "") : row.ja;
}

test("PDF oracle independently covers all 360 Day 29–34 questions", () => {
  assert.equal(oracle.schemaVersion, 1);
  assert.equal(oracle.questions.length, 360);
  assert.deepEqual(oracle.sources.map((source) => source.category).sort(), CATEGORIES.slice().sort());
  for (const source of oracle.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(source.pages, 30);
    assert.ok(source.driveFileId && source.modifiedTime && source.filename.endsWith(".pdf"));
  }
  assert.equal(new Set(oracle.questions.map((row) => row.questionId)).size, 360);
  for (const category of CATEGORIES) for (const day of DAYS) {
    const rows = oracle.questions.filter((row) => row.category === category && row.day === day);
    assert.equal(rows.length, 20, `${category} Day ${day}: complete PDF coverage`);
    assert.equal(new Set(rows.map((row) => row.sentence)).size, 20, "sentences unambiguously identify shuffled questions");
    assert.deepEqual(rows.map((row) => row.number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(rows.map((row) => row.practice_number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    for (const row of rows) {
      assert.equal(row.questionId, `2026-10/${category}/day${day}/q${String(row.number).padStart(2, "0")}`);
      assert.equal((row.sentence.match(/___/g) || []).length, 1);
      assert.equal(row.sentence.replace("___", row.answer), row.example, `${row.questionId}: PDF practice/key/list agreement`);
      assert.doesNotMatch(row.example, /\b(on|of|to|with|in|at|for|by)\s+\1\b/i, `${row.questionId}: no duplicated preposition`);
      const firstPage = (day - 29) * 5 + 1;
      assert.ok([firstPage, firstPage + 1].includes(row.source_page));
      assert.ok([firstPage + 2, firstPage + 3].includes(row.practice_page));
      assert.equal(row.answer_page, firstPage + 4);
    }
  }
  const depend = oracle.questions.find((row) => row.questionId === REGRESSION_ID);
  assert.equal(depend.answer, "depend on");
  assert.equal(depend.sentence, "Our plans ___ the weather this weekend.");
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function connectHost(baseUrl, cookie) {
  const socket = io(baseUrl, {
    forceNew: true, reconnection: false, timeout: 5_000,
    transports: ["websocket"], extraHeaders: { Cookie: cookie },
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  } catch (error) { socket.disconnect(); throw error; }
}

function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8_000);
    const callback = (response) => { clearTimeout(timer); resolve(response); };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  });
}

test("real Chromium learner solves all 360 PDF questions, submits, reloads, and reviews depend on", { timeout: 420_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-pdf-browser-"));
  const artifacts = process.env.PDF_BROWSER_ARTIFACT_DIR && path.resolve(process.env.PDF_BROWSER_ARTIFACT_DIR);
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  const report = { startedAt: new Date().toISOString(), browser: "real headless Chromium via CDP", sourceCheckedAt: oracle.sourceCheckedAt,
    scope: "isolated local server and synthetic learner; no production rooms", rounds: [], completedPdfQuestions: 0 };
  const stateFile = path.join(tempDir, "quiz-rooms.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, rooms: {}, resultHistory: {} }));
  const port = await reservePort();
  // No URL override: this test cannot accidentally target a production service.
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = `local-pdf-test-${randomUUID()}`;
  let stderr = "";
  let browser;
  let server;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await browser?.close();
    await stopProcess(server);
    report.finishedAt = new Date().toISOString();
    if (artifacts) fs.writeFileSync(path.join(artifacts, "pdf-learner-report.json"), JSON.stringify(report, null, 2) + "\n");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  try {
    server = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, NODE_ENV: "test", PORT: String(port), QUIZ_ROOM_STATE_FILE: stateFile,
        OPERATOR_PASSWORD: password, RESULTS_ADMIN_PASSWORD: "", SCHEDULE_LINK_SECRET: "", PUBLIC_BASE_URL: "",
        RAILWAY_ENVIRONMENT_ID: "", RAILWAY_SERVICE_ID: "", RAILWAY_PROJECT_ID: "", QUIZ_TEST_NOW_ISO: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-12_000); });
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Local test server exited: ${stderr}`);
      try { healthy = (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok; } catch {}
      if (healthy) break;
      await delay(50);
    }
    assert.ok(healthy, `Isolated test server must become healthy: ${stderr}`);
    const login = await fetch(`${baseUrl}/api/operator/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    browser = await startChrome(path.join(tempDir, "chrome-profile"));
    report.browserVersion = await browser.cdp.send("Browser.getVersion");

    async function savedResult(roomCode) {
      return browser.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVED_RESULTS_KEY)}) || '{}').records
        ?.find(record => record.roomCode === ${JSON.stringify(roomCode)})`);
    }

    async function assertResults(roomCode, ordered, expectedScore, wrongId) {
      await browser.screen("screen-results");
      const result = await browser.evaluate(`({
        score: document.querySelector('#personal-score').textContent,
        wrong: [...document.querySelectorAll('#review .review-item')].map(el => ({
          word: el.querySelector('.review-word').textContent,
          sentence: el.querySelector('.review-example').textContent.replace(/^Q\\d+\\s+/, ''),
          mine: el.querySelector('.review-mine').textContent })),
        correct: [...document.querySelectorAll('#correct-list strong')].map(el => el.textContent),
        summary: document.querySelector('#correct-summary').textContent,
        noteHidden: document.querySelector('#authoritative-result-note').hidden,
        saved: document.querySelector('#results-save-status').textContent
      })`);
      assert.equal(result.score, `${expectedScore} / 20点`, "official score rendered in real learner browser");
      assert.equal(result.wrong.length, 20 - expectedScore);
      assert.equal(result.summary, `正解だった単語 ${expectedScore}語`);
      assert.equal(result.noteHidden, true, "browser input matches the authoritative server outcome");
      assert.match(result.saved, /7日間/);
      assert.deepEqual(result.correct, ordered.flatMap((row, index) => row.questionId === wrongId ? [] : [`${index + 1}. ${row.answer}`]));
      const saved = await savedResult(roomCode);
      assert.ok(saved?.personalResult, "server-issued result retained for reopening");
      assert.equal(saved.personalResult.score, expectedScore);
      assert.equal(saved.personalResult.total, 20);
      assert.equal(saved.personalResult.submissionKind, "manual");
      assert.deepEqual(saved.personalResult.wrongQuestionIndexes, ordered.flatMap((row, index) => row.questionId === wrongId ? [index] : []));
      assert.deepEqual(saved.answers, ordered.map((row) => row.questionId === wrongId ? "depend" : row.answer));
      assert.equal(saved.review.length, 20);
      const persistedRoom = JSON.parse(fs.readFileSync(stateFile, "utf8")).rooms[roomCode];
      assert.equal(persistedRoom.phase, "finished");
      assert.equal(persistedRoom.questions.length, 20);
      saved.review.forEach((question, index) => {
        // Browser result storage deliberately omits IDs. Verify identity against
        // the isolated server's durable round only after the learner has solved it.
        assert.equal(persistedRoom.questions[index].questionId, ordered[index].questionId, "PDF sentence association resolves to the expected question ID");
        assert.equal(question.sentence, ordered[index].sentence);
        assert.equal(question.answer, ordered[index].answer, `${ordered[index].questionId}: revealed answer equals PDF key`);
        assert.equal(question.sentence.replace("___", question.answer), ordered[index].example, "revealed answer reconstructs exact PDF example");
      });
      if (wrongId) {
        const wrong = ordered.find((row) => row.questionId === wrongId);
        assert.equal(result.wrong[0].word, wrong.answer);
        assert.equal(result.wrong[0].sentence, wrong.example, "wrong-answer review reconstructs PDF example without an extra on");
        assert.doesNotMatch(result.wrong[0].sentence, /\bon\s+on\b/i);
        assert.match(result.wrong[0].mine, /：depend$/);
      }
    }

    async function round(category, day, { wrongId = null, checkReload = false } = {}) {
      const rows = oracle.questions.filter((row) => row.category === category && row.day === day);
      const bySentence = new Map(rows.map((row) => [row.sentence, row]));
      const host = await connectHost(baseUrl, cookie);
      sockets.push(host);
      const room = await ack(host, "quiz:createRoom", { category, name: "PDF QA host" });
      assert.ok(room.roomCode, JSON.stringify(room));
      // Select by public host metadata only, never by requiring the question bank.
      const seriesIndex = room.seriesNames.findIndex((name) => name === `Day ${day}`);
      assert.ok(seriesIndex >= 0, `${category} Day ${day} must be selectable`);
      const url = `${baseUrl}/quiz.html?room=${room.roomCode}&cat=${category}`;
      await browser.navigate("about:blank");
      await browser.cdp.send("Storage.clearDataForOrigin", { origin: baseUrl, storageTypes: "all" });
      await browser.navigate(url);
      await browser.screen("screen-entry");
      await browser.type("#name", "PDF QA");
      await browser.click("#btn-join");
      await browser.screen("screen-lobby");
      assert.deepEqual(await ack(host, "quiz:selectSeries", { seriesIndex }), { ok: true });
      assert.deepEqual(await ack(host, "quiz:startGame", { seriesIndex }), { ok: true });
      await browser.screen("screen-quiz");
      const ordered = [];
      for (let index = 0; index < 20; index += 1) {
        await browser.waitFor(`document.querySelector('#q-num')?.textContent === ${JSON.stringify(`第${index + 1}問 / 20`)}`, `${category} Day ${day} question ${index + 1}`);
        const visible = await browser.evaluate(`({sentence: document.querySelector('#q-sentence').textContent,
          meaning: document.querySelector('#q-ja').textContent, translation: document.querySelector('#q-sentence-ja').textContent,
          hint: document.querySelector('#q-hint').textContent, value: document.querySelector('#answer').value})`);
        const expected = bySentence.get(visible.sentence);
        assert.ok(expected, `${category} Day ${day}: displayed sentence must match the PDF oracle: ${visible.sentence}`);
        assert.ok(!ordered.some((row) => row.questionId === expected.questionId), "no question repeats in the shuffled round");
        assert.equal(visible.meaning, displayMeaning(expected), `${expected.questionId}: PDF meaning`);
        assert.equal(visible.translation, expected.sentenceJa, `${expected.questionId}: PDF translation`);
        assert.equal(visible.hint, expected.answer.slice(0, 1).toLowerCase(), `${expected.questionId}: initial hint`);
        assert.equal(visible.sentence.replace("___", expected.answer), expected.example, `${expected.questionId}: complete PDF example`);
        assert.equal(visible.value, "", "new questions start with an empty answer");
        ordered.push(expected);
        await browser.type("#answer", expected.questionId === wrongId ? "depend" : expected.answer);
        await browser.click("#btn-next");
      }
      assert.deepEqual(ordered.map((row) => row.questionId).sort(), rows.map((row) => row.questionId).sort(), "all 20 PDF questions were typed exactly once");
      await browser.screen("screen-confirm");
      assert.equal(await browser.evaluate("document.querySelector('#confirm-summary').textContent"), "回答済み20問／未回答0問");
      assert.equal(await browser.evaluate("document.querySelector('#unanswered-box').hidden"), true);
      await browser.click("#answered-toggle summary");
      const confirmation = await browser.evaluate("[...document.querySelectorAll('#confirm-list small')].map(el => el.textContent)");
      assert.deepEqual(confirmation, ordered.map((row) => `入力した答え：${row.questionId === wrongId ? "depend" : row.answer}　— 修正する`));
      if (checkReload) {
        // Exercise returning from the final confirmation and reopening it without
        // losing the final multiword answer or accidentally submitting twice.
        await browser.click("#btn-confirm-back");
        await browser.screen("screen-quiz");
        assert.equal(await browser.evaluate("document.querySelector('#answer').value"), ordered[19].questionId === wrongId ? "depend" : ordered[19].answer);
        await browser.click("#btn-next");
        await browser.screen("screen-confirm");
      }
      await browser.click("#btn-confirm-submit");
      await browser.screen("screen-waiting");
      await browser.waitFor("document.querySelector('#waiting-count').textContent === '1 / 1人'", "one learner submitted");
      if (checkReload) {
        await browser.reload();
        await browser.screen("screen-waiting");
        assert.match(await browser.evaluate("document.querySelector('#waiting-timer').textContent"), /^残り時間 \d+:\d{2}$/);
        assert.equal(await browser.evaluate("document.querySelector('#waiting-count').textContent"), "1 / 1人");
      }
      assert.deepEqual(await ack(host, "quiz:revealResults"), { ok: true });
      await assertResults(room.roomCode, ordered, wrongId ? 19 : 20, wrongId);
      if (wrongId) {
        if (artifacts) await browser.screenshot(path.join(artifacts, "depend-on-review.png"));
        await browser.click("#btn-retest");
        await browser.screen("screen-retest");
        const expected = rows.find((row) => row.questionId === wrongId);
        assert.equal(await browser.evaluate("document.querySelector('#retest-sentence').textContent"), expected.sentence);
        await browser.type("#retest-answer", expected.answer);
        await browser.click("#retest-next");
        assert.equal(await browser.evaluate("document.querySelector('#retest-feedback').textContent"), "正解 🎉");
        assert.equal(await browser.evaluate("document.querySelector('#retest-correct').textContent"), "正解：depend on");
        if (artifacts) await browser.screenshot(path.join(artifacts, "depend-on-retry.png"));
        await browser.click("#retest-next");
        assert.equal(await browser.evaluate("document.querySelector('#retest-done').textContent"), "1語中 1語 正解");
        await browser.click("#retest-quit");
        await browser.screen("screen-results");
      }
      if (checkReload) {
        await browser.reload();
        await assertResults(room.roomCode, ordered, wrongId ? 19 : 20, wrongId);
      }
      assert.deepEqual(browser.cdp.exceptions, [], "no uncaught browser JavaScript exceptions");
      if (!wrongId) report.completedPdfQuestions += 20;
      report.rounds.push({ category, day, count: 20, score: wrongId ? 19 : 20, wrongId, reloadVerified: checkReload, questionIds: ordered.map((row) => row.questionId) });
      t.diagnostic(`${category} Day ${day}: real Chrome ${wrongId ? "19/20 + depend on retry" : "20/20"}${checkReload ? "; submitted/result reload verified" : ""}`);
      host.disconnect();
    }

    for (const category of CATEGORIES) for (const day of DAYS) {
      await round(category, day, { checkReload: day === 29 });
    }
    await round("clacel", 33, { wrongId: REGRESSION_ID, checkReload: true });
    assert.equal(report.completedPdfQuestions, 360);
    assert.equal(report.rounds.length, 19);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    if (artifacts && browser) {
      await browser.screenshot(path.join(artifacts, "pdf-learner-failure.png")).catch(() => {});
      const state = await browser.evaluate("({url: location.href, text: document.body.innerText})").catch(() => null);
      if (state) fs.writeFileSync(path.join(artifacts, "pdf-learner-failure.json"), JSON.stringify(state, null, 2));
    }
    throw error;
  }
});
