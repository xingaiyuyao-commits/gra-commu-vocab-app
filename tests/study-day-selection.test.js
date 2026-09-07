const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { io: createSocketClient } = require("socket.io-client");

const OPERATOR_PASSWORD = "study-day-test-password";

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealthy(baseUrl, child, getStderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited: ${getStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy: ${getStderr()}`);
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5_000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function runAt(iso) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      OPERATOR_PASSWORD,
      QUIZ_TEST_NOW_ISO: iso,
      QUIZ_ROOM_STATE_FILE: "",
      RAILWAY_ENVIRONMENT_ID: "",
      RAILWAY_SERVICE_ID: "",
      RAILWAY_PROJECT_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForHealthy(baseUrl, child, () => stderr);

  const login = await fetch(`${baseUrl}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const socket = createSocketClient(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie },
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  try {
    const schedule = await fetch(`${baseUrl}/api/study-day`).then((response) => response.json());
    const room = await emitWithAck(socket, "quiz:createRoom", { category: "ielts", name: "境界確認" });
    return { schedule, room };
  } finally {
    socket.disconnect();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("9月6日・7日の19時30分境界でホーム表示と新規ルームの初期選択が一致する", async () => {
  const cases = [
    ["2026-09-06T19:29:59+09:00", null, 0, "体験会"],
    ["2026-09-06T19:30:00+09:00", 1, 1, "Day 1"],
    ["2026-09-07T19:29:59+09:00", 1, 1, "Day 1"],
    ["2026-09-07T19:30:00+09:00", 2, 2, "Day 2"],
  ];

  for (const [iso, day, selectedSeriesIndex, name] of cases) {
    const result = await runAt(iso);
    assert.equal(result.schedule.studyDay, day, iso);
    assert.equal(result.room.selectedSeriesIndex, selectedSeriesIndex, iso);
    assert.equal(result.room.seriesNames[selectedSeriesIndex], name, iso);
  }
});
