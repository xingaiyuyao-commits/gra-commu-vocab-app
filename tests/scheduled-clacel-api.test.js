const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { io: createSocketClient } = require("socket.io-client");
const { makeScheduledToken } = require("../scheduled-clacel-links");

const OPERATOR_PASSWORD = "operator-test-password";
const LINK_SECRET = "scheduled-link-test-secret";
const TODAY = "2026-09-14";

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "::", () => {
      const { port } = socket.address();
      socket.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startServer(t, stateFile, overrides = {}) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      QUIZ_ROOM_STATE_FILE: stateFile,
      OPERATOR_PASSWORD,
      SCHEDULE_LINK_SECRET: LINK_SECRET,
      QUIZ_TEST_NOW_ISO: "2026-09-14T10:00:00.000Z",
      ...overrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(stderr || "server exited");
    try {
      if ((await fetch(`${baseUrl}/healthz`)).status === 200) return { child, baseUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function connect(baseUrl, cookie) {
  const socket = createSocketClient(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5_000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function scheduledStatusUrl(baseUrl, date = TODAY, token = makeScheduledToken(date, LINK_SECRET)) {
  return `${baseUrl}/api/scheduled/clacel/${date}?token=${encodeURIComponent(token)}`;
}

function courseStatusUrl(baseUrl, course, date = TODAY, token = makeScheduledToken(date, LINK_SECRET, course)) {
  return `${baseUrl}/api/scheduled/${course}/${date}?token=${encodeURIComponent(token)}`;
}

function makeStateFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "osh-scheduled-clacel-"));
  const stateFile = path.join(directory, "quiz-rooms.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, rooms: {}, resultHistory: {} }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return stateFile;
}

test("運営者だけが9月14日から30日までの固定参加URLを取得できる", async (t) => {
  const stateFile = makeStateFile(t);
  const { baseUrl } = await startServer(t, stateFile);

  assert.equal((await fetch(`${baseUrl}/api/operator/scheduled-clacel-links`)).status, 401);
  const cookie = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/operator/scheduled-clacel-links`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.links.length, 17);
  assert.equal(body.links[0].date, "2026-09-14");
  assert.equal(body.links[16].date, "2026-09-30");
  assert.equal(body.links[0].scheduledAt, "2026-09-14T19:00:00+09:00");
  assert.match(body.links[0].url, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/quiz\\.html\\?`));
  assert.match(body.links[0].url, /mode=scheduled/);
  assert.match(body.links[0].url, /course=clacel/);

  assert.equal((await fetch(`${baseUrl}/api/operator/scheduled-links`)).status, 401);
  const allResponse = await fetch(`${baseUrl}/api/operator/scheduled-links`, { headers: { Cookie: cookie } });
  assert.equal(allResponse.status, 200);
  const allBody = await allResponse.json();
  assert.deepEqual(Object.keys(allBody.courses), ["clacel", "toeic", "ielts"]);
  for (const course of ["clacel", "toeic", "ielts"]) {
    assert.equal(allBody.courses[course].length, 17);
    assert.match(allBody.courses[course][10].url, new RegExp(`course=${course}`));
  }
});

test("公開ステータスAPIは署名と東京日付を検証する", async (t) => {
  const stateFile = makeStateFile(t);
  const { baseUrl } = await startServer(t, stateFile);

  assert.deepEqual(await (await fetch(scheduledStatusUrl(baseUrl))).json(), { status: "waiting", date: TODAY });
  assert.deepEqual(
    await (await fetch(scheduledStatusUrl(baseUrl, "2026-09-15"))).json(),
    { status: "future", date: "2026-09-15" },
  );
  assert.equal((await fetch(scheduledStatusUrl(baseUrl, TODAY, "modified-token"))).status, 403);
  assert.equal((await fetch(scheduledStatusUrl(baseUrl, "2026-10-01", "anything"))).status, 404);
});

test("当日のClacelルームは一度だけ固定URLへ紐づき、開始・終了・再起動後も状態を保持する", async (t) => {
  const stateFile = makeStateFile(t);
  const first = await startServer(t, stateFile);
  const cookie = await login(first.baseUrl);
  const host = await connect(first.baseUrl, cookie);
  t.after(() => host.disconnect());

  const created = await emit(host, "quiz:createRoom", { category: "clacel", name: "ホスト" });
  assert.equal(created.error, undefined);
  assert.match(created.scheduledJoinUrl, /mode=scheduled/);
  assert.equal(created.selectedSeriesIndex, 9, "19:00の作成でも日付どおりDay 9を選ぶ");
  assert.deepEqual(await (await fetch(scheduledStatusUrl(first.baseUrl))).json(), {
    status: "lobby", date: TODAY, roomCode: created.roomCode,
  });

  const secondHost = await connect(first.baseUrl, cookie);
  t.after(() => secondHost.disconnect());
  const duplicate = await emit(secondHost, "quiz:createRoom", { category: "clacel", name: "別ホスト" });
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.roomCode, created.roomCode);
  assert.equal(duplicate.isHost, true);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.playerId, created.playerId);
  assert.equal(duplicate.sessionToken, created.sessionToken);

  assert.deepEqual(await emit(host, "quiz:startGame", { seriesIndex: 8 }), {
    ok: false,
    error: "固定参加リンクの日付と問題Dayが一致していません",
  });
  assert.deepEqual(await emit(host, "quiz:startGame", { seriesIndex: 9 }), { ok: true });
  assert.deepEqual(await (await fetch(scheduledStatusUrl(first.baseUrl))).json(), {
    status: "playing", date: TODAY, roomCode: created.roomCode,
  });

  assert.deepEqual(await emit(host, "quiz:leave"), { ok: true });
  assert.deepEqual(await (await fetch(scheduledStatusUrl(first.baseUrl))).json(), {
    status: "finished", date: TODAY,
  });
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(stored.version, 3);
  assert.equal(stored.scheduledClacelEvents[TODAY].status, "finished");

  host.disconnect();
  secondHost.disconnect();
  await stopServer(first.child);
  const restarted = await startServer(t, stateFile);
  assert.deepEqual(await (await fetch(scheduledStatusUrl(restarted.baseUrl))).json(), {
    status: "finished", date: TODAY,
  });
});

test("3コースは同じ日に固定URLへ別々のルームを紐づける", async (t) => {
  const stateFile = makeStateFile(t);
  const server = await startServer(t, stateFile);
  const cookie = await login(server.baseUrl);
  const first = await connect(server.baseUrl, cookie);
  const second = await connect(server.baseUrl, cookie);
  t.after(() => { first.disconnect(); second.disconnect(); });

  const toeic = await emit(first, "quiz:createRoom", { category: "toeic", name: "T" });
  const ielts = await emit(second, "quiz:createRoom", { category: "ielts", name: "I" });
  assert.equal(toeic.error, undefined);
  assert.equal(ielts.error, undefined);
  assert.notEqual(toeic.roomCode, ielts.roomCode);
  assert.match(toeic.scheduledJoinUrl, /course=toeic/);
  assert.match(ielts.scheduledJoinUrl, /course=ielts/);
  assert.deepEqual(await (await fetch(courseStatusUrl(server.baseUrl, "toeic"))).json(), {
    status: "lobby", date: TODAY, roomCode: toeic.roomCode,
  });
  assert.deepEqual(await (await fetch(courseStatusUrl(server.baseUrl, "ielts"))).json(), {
    status: "lobby", date: TODAY, roomCode: ielts.roomCode,
  });
  assert.equal((await fetch(courseStatusUrl(server.baseUrl, "toeic", TODAY, makeScheduledToken(TODAY, LINK_SECRET, "ielts")))).status, 403);

  first.disconnect();
  second.disconnect();
  await stopServer(server.child);
  const restarted = await startServer(t, stateFile);
  assert.deepEqual(await (await fetch(courseStatusUrl(restarted.baseUrl, "toeic"))).json(), {
    status: "lobby", date: TODAY, roomCode: toeic.roomCode,
  });
  assert.deepEqual(await (await fetch(courseStatusUrl(restarted.baseUrl, "ielts"))).json(), {
    status: "lobby", date: TODAY, roomCode: ielts.roomCode,
  });
});
