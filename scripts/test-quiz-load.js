const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const PARTICIPANT_COUNT = 99;
const MAX_CONCURRENCY = 12;
const OPERATION_TIMEOUT_MS = 15_000;
const LOAD_TEST_TIMEOUT_MS = positiveInteger(process.env.QUIZ_LOAD_TIMEOUT_MS, 60_000);
const FIXED_NOW = "2042-01-02T03:04:05.000Z";
const HISTORY_KEY = "2042-01-02:clacel";
const TEST_OPERATOR_PASSWORD = "load-test-operator-password";

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function withTimeout(promise, label, timeoutMs = OPERATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function emitWithAck(socket, event, payload) {
  return withTimeout(new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  }), `${event} acknowledgement`);
}

function emitWithoutPayloadWithAck(socket, event) {
  return withTimeout(new Promise((resolve) => {
    socket.emit(event, resolve);
  }), `${event} acknowledgement`);
}

function waitForEvent(socket, event) {
  return withTimeout(new Promise((resolve) => {
    socket.once(event, resolve);
  }), `${event} event`);
}

async function mapWithConcurrency(items, concurrency, operation) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function cleanup(resources) {
  if (resources.cleaned) return;
  resources.cleaned = true;
  for (const socket of resources.sockets) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  await stopServer(resources.server);
  if (resources.tempDir) fs.rmSync(resources.tempDir, { recursive: true, force: true });
}

async function startTemporaryServer(resources) {
  if (!resources.tempDir) {
    resources.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-quiz-load-"));
    resources.stateFile = path.join(resources.tempDir, "quiz-rooms.json");
  }
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    QUIZ_ROOM_STATE_FILE: resources.stateFile,
    QUIZ_TEST_NOW_ISO: FIXED_NOW,
    OPERATOR_PASSWORD: TEST_OPERATOR_PASSWORD,
  };
  for (const variable of [
    "RESULTS_ADMIN_PASSWORD",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_PROJECT_ID",
  ]) delete env[variable];

  let stderr = "";
  resources.server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  resources.server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (resources.server.exitCode !== null || resources.server.signalCode !== null) {
      throw new Error(`temporary server exited before becoming healthy: ${stderr || "no stderr"}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        const login = await fetch(`${baseUrl}/api/operator/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_OPERATOR_PASSWORD }),
        });
        resources.operatorCookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";
        return baseUrl;
      }
    } catch {}
    await delay(50);
  }
  throw new Error(`temporary server did not become healthy: ${stderr || "no stderr"}`);
}

async function connectSocket(baseUrl, resources, { operator = false } = {}) {
  const socket = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    timeout: OPERATION_TIMEOUT_MS,
    transports: ["websocket"],
    extraHeaders: operator && resources.operatorCookie ? { Cookie: resources.operatorCookie } : undefined,
  });
  resources.sockets.push(socket);
  await withTimeout(new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  }), "Socket.IO connection");
  return socket;
}

function answersForParticipant(questions, participantIndex) {
  const answers = questions.map((question) => question.answer);
  if (participantIndex === 0) return answers;
  answers[0] = "__load_test_wrong__";
  if (participantIndex <= 75) answers[1] = "__load_test_wrong__";
  if (participantIndex <= 50) answers[2] = "__load_test_wrong__";
  if (participantIndex <= 25) answers[3] = "__load_test_wrong__";
  return answers;
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

async function runLoadTest(resources) {
  const baseUrl = await startTemporaryServer(resources);
  const host = await connectSocket(baseUrl, resources, { operator: true });
  const created = await emitWithAck(host, "quiz:createRoom", { category: "clacel", name: "Load Host" });
  assert.equal(created.isHost, true);
  assert.match(created.roomCode, /^[A-Z2-9]{4}$/);

  const participants = new Array(PARTICIPANT_COUNT);
  await mapWithConcurrency(participants, MAX_CONCURRENCY, async (_unused, index) => {
    const socket = await connectSocket(baseUrl, resources);
    const name = `Load-${String(index + 1).padStart(3, "0")}`;
    const joined = await emitWithAck(socket, "quiz:joinRoom", { roomCode: created.roomCode, name });
    assert.equal(joined.roomCode, created.roomCode);
    assert.equal(joined.isHost, false);
    participants[index] = socket;
  });

  let submitted = 0;
  async function runRound(seriesIndex, expectedTotal, expectedDurationSec) {
    const startedEvent = waitForEvent(host, "quiz:started");
    assert.deepEqual(await emitWithAck(host, "quiz:startGame", { seriesIndex }), { ok: true });
    const started = await startedEvent;
    assert.equal(started.total, expectedTotal);
    const startedState = readState(resources.stateFile);
    const room = startedState.rooms[created.roomCode];
    assert.equal(Object.keys(room.players).length, PARTICIPANT_COUNT + 1);
    assert.equal(room.questions.length, expectedTotal);
    assert.equal(room.endsAt - room.startedAt, expectedDurationSec * 1000);
    assert.equal(new Set(room.questions.map(({ questionId }) => questionId)).size, expectedTotal);

    const readyToReveal = waitForEvent(host, "quiz:readyToReveal");
    await mapWithConcurrency(participants, MAX_CONCURRENCY, async (socket, index) => {
      const response = await emitWithAck(socket, "quiz:submit", {
        answers: answersForParticipant(room.questions, index),
      });
      assert.deepEqual(response, { ok: true });
      submitted += 1;
    });
    await readyToReveal;

    const resultsEvent = waitForEvent(host, "quiz:results");
    assert.deepEqual(await emitWithoutPayloadWithAck(host, "quiz:revealResults"), { ok: true });
    const results = await resultsEvent;
    assert.equal(results.resultAt, FIXED_NOW);
    assert.equal(results.perfect.length, 1);
    assert.equal(results.perfect[0].name, "Load-001");
    assert.equal(results.others.length, 98);
    assert.deepEqual(results.mistakes, [
      { index: 0, answer: room.questions[0].answer, ja: room.questions[0].ja, count: 98, reasonCounts: { other: 98 } },
      { index: 1, answer: room.questions[1].answer, ja: room.questions[1].ja, count: 75, reasonCounts: { other: 75 } },
      { index: 2, answer: room.questions[2].answer, ja: room.questions[2].ja, count: 50, reasonCounts: { other: 50 } },
    ]);
    const saved = readState(resources.stateFile);
    assert.equal(saved.resultHistory[HISTORY_KEY].questionStats.length, expectedTotal);
    return { started, room, results, saved };
  }

  const normal = await runRound(1, 20, 300);
  assert.match(normal.started.setLabel, /Day 1/);
  assert.deepEqual(await emitWithoutPayloadWithAck(host, "quiz:playAgain"), { ok: true });
  const review = await runRound(7, 50, 750);
  assert.match(review.started.setLabel, /Day 7（復習50問）/);
  assert.equal(review.saved.version, 2);
  assert.equal(review.saved.rooms[created.roomCode].results.resultAt, FIXED_NOW);
  assert.deepEqual(review.saved.rooms[created.roomCode].results.mistakes, review.results.mistakes);
  assert.equal(review.saved.resultHistory[HISTORY_KEY].participantCount, PARTICIPANT_COUNT);
  assert.deepEqual(review.saved.resultHistory[HISTORY_KEY].perfectNames, ["Load-001"]);
  assert.equal(review.saved.resultHistory[HISTORY_KEY].day, 7);
  assert.equal(review.saved.resultHistory[HISTORY_KEY].questionStats.length, 50);

  for (const socket of resources.sockets) socket.disconnect();
  resources.sockets = [];
  await stopServer(resources.server);
  resources.server = null;
  const restartedBaseUrl = await startTemporaryServer(resources);
  const restoredHost = await connectSocket(restartedBaseUrl, resources, { operator: true });
  const restored = await emitWithAck(restoredHost, "quiz:rejoin", {
    roomCode: created.roomCode,
    playerId: created.playerId,
    sessionToken: created.sessionToken,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.phase, "finished");
  assert.equal(restored.results.review.length, 50);

  assert.deepEqual(await emitWithAck(restoredHost, "quiz:leave", {}), { ok: true });
  const afterRoomEnd = readState(resources.stateFile);
  assert.equal(Object.hasOwn(afterRoomEnd.rooms, created.roomCode), false);
  assert.deepEqual(afterRoomEnd.resultHistory[HISTORY_KEY], review.saved.resultHistory[HISTORY_KEY]);

  return {
    connections: { hosts: 1, participants: participants.length },
    actions: { joined: participants.filter(Boolean).length, submitted, normalRevealed: true, reviewRevealed: true, restarted: true, roomEnded: true },
    normal: { total: normal.room.questions.length, durationSec: 300 },
    review: { total: review.room.questions.length, durationSec: 750, topMistakes: review.results.mistakes },
    history: {
      stateVersion: review.saved.version,
      key: HISTORY_KEY,
      participantCount: review.saved.resultHistory[HISTORY_KEY].participantCount,
      perfectNames: review.saved.resultHistory[HISTORY_KEY].perfectNames,
      questionStats: review.saved.resultHistory[HISTORY_KEY].questionStats.length,
      roomRemoved: !Object.hasOwn(afterRoomEnd.rooms, created.roomCode),
      retainedAfterRoomEnd: JSON.stringify(afterRoomEnd.resultHistory[HISTORY_KEY])
        === JSON.stringify(review.saved.resultHistory[HISTORY_KEY]),
    },
  };
}

async function main() {
  const resources = { sockets: [], server: null, stateFile: null, tempDir: null, cleaned: false };
  let deadline;
  const terminate = async (message, exitCode) => {
    clearTimeout(deadline);
    await cleanup(resources);
    if (message) console.error(message);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => { terminate("load test interrupted", 130); });
  process.once("SIGTERM", () => { terminate("load test terminated", 143); });
  deadline = setTimeout(() => {
    terminate(`load test timed out after ${LOAD_TEST_TIMEOUT_MS}ms`, 1);
  }, LOAD_TEST_TIMEOUT_MS);

  try {
    const summary = await runLoadTest(resources);
    console.log(JSON.stringify(summary));
  } finally {
    clearTimeout(deadline);
    await cleanup(resources);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
