const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function reviewQuestions() {
  return Array.from({ length: 50 }, (_, index) => ({
    sentence: `The example has ___ number ${index + 1}.`,
    answer: "word",
    base: "word",
    hint: "w___",
    ja: "語",
    sentenceJa: `例文は${index + 1}番です。`,
  }));
}

async function startServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-review-pdf-"));
  const stateFile = path.join(tempDir, "quiz-rooms.json");
  const hostId = "host-player";
  const hostToken = "host-session-token";
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 2,
    rooms: {
      PDF7: {
        category: "toeic",
        host: hostId,
        phase: "playing",
        players: {
          [hostId]: {
            name: "運営",
            sessionToken: hostToken,
            submittedAt: null,
            submissionKind: null,
            score: 0,
            wrongQuestionIndexes: [],
            wrongAnswerReasons: {},
          },
        },
        questions: reviewQuestions(),
        startedAt: Date.now(),
        endsAt: Date.now() + 750000,
        setLabel: "TOEIC Day 7（復習50問）",
        day: 7,
        datasetRevision: "test-revision",
        isReview: true,
        sourceDays: [1, 2, 3, 4, 5, 6],
        isTrial: false,
        results: null,
      },
      NOR7: {
        category: "toeic",
        host: hostId,
        phase: "playing",
        players: {
          [hostId]: { name: "運営", sessionToken: hostToken, submittedAt: null, submissionKind: null, score: 0, wrongQuestionIndexes: [], wrongAnswerReasons: {} },
        },
        questions: reviewQuestions(),
        startedAt: Date.now(),
        endsAt: Date.now() + 180000,
        setLabel: "TOEIC Day 1",
        day: 1,
        datasetRevision: "test-revision",
        isReview: false,
        sourceDays: [],
        isTrial: false,
        results: null,
      },
      WAIT: {
        category: "toeic",
        host: hostId,
        phase: "lobby",
        players: {
          [hostId]: { name: "運営", sessionToken: hostToken, submittedAt: null, submissionKind: null, score: 0, wrongQuestionIndexes: [], wrongAnswerReasons: {} },
        },
        questions: [],
        startedAt: 0,
        endsAt: 0,
        setLabel: "",
        day: 7,
        datasetRevision: "test-revision",
        isReview: true,
        sourceDays: [1, 2, 3, 4, 5, 6],
        isTrial: false,
        results: null,
      },
    },
    resultHistory: {},
  }));
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      QUIZ_ROOM_STATE_FILE: stateFile,
      OPERATOR_PASSWORD: "shared password",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(stderr || "server exited");
    try {
      if ((await fetch(`${baseUrl}/healthz`)).status === 200) return { baseUrl, hostId, hostToken };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function operatorCookie(baseUrl) {
  const response = await fetch(`${baseUrl}/api/operator/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "shared password" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("復習開始後はホストだけが欠席者用PDFの50問を取得できる", async (t) => {
  const { baseUrl, hostId, hostToken } = await startServer(t);
  const cookie = await operatorCookie(baseUrl);
  const response = await fetch(`${baseUrl}/api/operator/review-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ roomCode: "PDF7", playerId: hostId, sessionToken: hostToken }),
  });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.setLabel, "TOEIC Day 7（復習50問）");
  assert.equal(document.questions.length, 50);
  assert.equal(document.questions[0].sentence, "The example has ___ number 1.");
  assert.equal(Object.hasOwn(document.questions[0], "sessionToken"), false);
});

test("欠席者用PDFは参加者・通常日・未開始の復習日から取得できない", async (t) => {
  const { baseUrl, hostId, hostToken } = await startServer(t);
  const cookie = await operatorCookie(baseUrl);
  const post = (body) => fetch(`${baseUrl}/api/operator/review-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ roomCode: "PDF7", playerId: "other-player", sessionToken: hostToken })).status, 403);
  assert.equal((await post({ roomCode: "PDF7", playerId: hostId, sessionToken: "wrong-token" })).status, 403);
  assert.equal((await post({ roomCode: "NOR7", playerId: hostId, sessionToken: hostToken })).status, 409);
  assert.equal((await post({ roomCode: "WAIT", playerId: hostId, sessionToken: hostToken })).status, 409);
  assert.equal((await post({ roomCode: "NONE", playerId: hostId, sessionToken: hostToken })).status, 404);
});

test("欠席者用PDFは運営ログインなしでは取得できない", async (t) => {
  const { baseUrl, hostId, hostToken } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/operator/review-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomCode: "PDF7", playerId: hostId, sessionToken: hostToken }),
  });
  assert.equal(response.status, 401);
});
