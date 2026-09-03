const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { io: createSocketClient } = require("socket.io-client");

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(baseUrl, child, getStderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`test server exited before becoming healthy: ${getStderr() || "no stderr"}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`test server did not become healthy: ${getStderr() || "no stderr"}`);
}

function connectSocket(baseUrl) {
  const socket = createSocketClient(baseUrl, {
    forceNew: true,
    reconnection: false,
    timeout: 5_000,
    transports: ["websocket"],
  });
  const connected = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, connected };
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5_000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForEvent(socket, event, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`${event} timed out`));
    }, 5_000);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("実サーバー: プレイヤー固有トークンだけが再参加とIDの所有権を認証する", async (t) => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  t.after(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    await stopChild(child);
  });

  await waitForHealthy(baseUrl, child, () => stderr);

  async function openSocket() {
    const connection = connectSocket(baseUrl);
    sockets.push(connection.socket);
    await connection.connected;
    return connection.socket;
  }

  const host = await openSocket();
  const hostResponse = await emitWithAck(host, "quiz:createRoom", {
    category: "clacel",
    name: "ホスト",
  });
  assert.equal(hostResponse.error, undefined);
  assert.equal(typeof hostResponse.sessionToken, "string");
  assert.ok(hostResponse.sessionToken.length > 0, "ホストに空でないトークンを返す");

  const participantAppears = waitForEvent(
    host,
    "quiz:playersUpdate",
    ({ players } = {}) => Array.isArray(players) && players.some((player) => player.name === "参加者"),
  );
  const participant = await openSocket();
  const participantResponse = await emitWithAck(participant, "quiz:joinRoom", {
    roomCode: hostResponse.roomCode,
    name: "参加者",
  });
  assert.equal(participantResponse.error, undefined);
  assert.equal(typeof participantResponse.sessionToken, "string");
  assert.ok(participantResponse.sessionToken.length > 0, "参加者に空でないトークンを返す");
  assert.notEqual(participantResponse.sessionToken, hostResponse.sessionToken, "プレイヤーごとに別のトークンを発行する");

  const playersUpdate = await participantAppears;
  assert.deepEqual(playersUpdate.players.map(({ name }) => name), ["ホスト", "参加者"]);
  for (const player of playersUpdate.players) {
    assert.equal(Object.hasOwn(player, "sessionToken"), false, "playersUpdateにトークンを含めない");
  }

  const roomInfo = await emitWithAck(host, "quiz:roomInfo", { roomCode: hostResponse.roomCode });
  assert.deepEqual(roomInfo, { category: "clacel" }, "roomInfoにトークンを含めない");

  const attemptedTakeover = await openSocket();
  const takeoverResponse = await emitWithAck(attemptedTakeover, "quiz:joinRoom", {
    roomCode: hostResponse.roomCode,
    name: "なりすまし",
    playerId: hostResponse.playerId,
  });
  assert.notEqual(takeoverResponse.playerId, hostResponse.playerId, "joinRoomで既存IDを取得できない");
  assert.equal(takeoverResponse.isHost, false, "joinRoomでホスト権限を取得できない");

  participant.disconnect();

  const missingTokenSocket = await openSocket();
  const missingTokenResponse = await emitWithAck(missingTokenSocket, "quiz:rejoin", {
    roomCode: hostResponse.roomCode,
    playerId: participantResponse.playerId,
  });
  assert.deepEqual(missingTokenResponse, { ok: false });
  missingTokenSocket.emit("quiz:leave");

  const wrongTokenSocket = await openSocket();
  const wrongTokenResponse = await emitWithAck(wrongTokenSocket, "quiz:rejoin", {
    roomCode: hostResponse.roomCode,
    playerId: participantResponse.playerId,
    sessionToken: `${participantResponse.sessionToken}-wrong`,
  });
  assert.deepEqual(wrongTokenResponse, { ok: false });
  wrongTokenSocket.emit("quiz:leave");

  const correctTokenSocket = await openSocket();
  const correctTokenResponse = await emitWithAck(correctTokenSocket, "quiz:rejoin", {
    roomCode: hostResponse.roomCode,
    playerId: participantResponse.playerId,
    sessionToken: participantResponse.sessionToken,
  });
  assert.equal(correctTokenResponse.ok, true);
  assert.equal(correctTokenResponse.isHost, false);
  assert.equal(correctTokenResponse.category, "clacel");
  assert.equal(correctTokenResponse.phase, "lobby");

  assert.equal(stdout.includes(hostResponse.sessionToken), false, "ホストトークンをログに出さない");
  assert.equal(stdout.includes(participantResponse.sessionToken), false, "参加者トークンをログに出さない");
  assert.equal(stderr.includes(hostResponse.sessionToken), false, "ホストトークンをエラーログに出さない");
  assert.equal(stderr.includes(participantResponse.sessionToken), false, "参加者トークンをエラーログに出さない");
});

test("実サーバー: 制限時間内の途中参加者へ進行中の同じ問題と期限を返し、提出人数へ加える", async (t) => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  t.after(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    await stopChild(child);
  });

  await waitForHealthy(baseUrl, child, () => stderr);

  async function openSocket() {
    const connection = connectSocket(baseUrl);
    sockets.push(connection.socket);
    await connection.connected;
    return connection.socket;
  }

  const host = await openSocket();
  const room = await emitWithAck(host, "quiz:createRoom", { category: "clacel", name: "ホスト" });
  const first = await openSocket();
  await emitWithAck(first, "quiz:joinRoom", { roomCode: room.roomCode, name: "先発参加者" });

  const startedForFirst = waitForEvent(first, "quiz:started", ({ questions } = {}) => Array.isArray(questions));
  const startResponse = await emitWithAck(host, "quiz:startGame", { seriesIndex: 0 });
  assert.equal(startResponse.ok, true);
  const started = await startedForFirst;

  const readyBeforeLateJoin = waitForEvent(host, "quiz:readyToReveal", () => true);
  const firstSubmit = await emitWithAck(first, "quiz:submit", { answers: [] });
  assert.equal(firstSubmit.ok, true);
  await readyBeforeLateJoin;

  const progressAfterLateJoin = waitForEvent(
    host,
    "quiz:submitProgress",
    ({ submitted, total } = {}) => submitted === 1 && total === 2,
  );
  const late = await openSocket();
  const lateResponse = await emitWithAck(late, "quiz:joinRoom", {
    roomCode: room.roomCode,
    name: "途中参加者",
  });

  assert.equal(lateResponse.error, undefined);
  assert.equal(lateResponse.phase, "playing");
  assert.equal(lateResponse.setLabel, started.setLabel);
  assert.equal(lateResponse.total, started.total);
  assert.equal(lateResponse.endsAt, started.endsAt, "先発参加者と同じ終了時刻を使う");
  assert.deepEqual(lateResponse.questions, started.questions, "途中参加でも同じ出題順を使う");
  await progressAfterLateJoin;
});
