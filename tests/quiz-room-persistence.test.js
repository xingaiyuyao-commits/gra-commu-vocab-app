const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
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

async function startServer(stateFile) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), QUIZ_ROOM_STATE_FILE: stateFile },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`test server exited before becoming healthy: ${stderr || "no stderr"}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return { child, baseUrl };
    } catch {}
    await delay(50);
  }
  throw new Error(`test server did not become healthy: ${stderr || "no stderr"}`);
}

async function stopServer(child) {
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

async function connect(baseUrl) {
  const socket = createSocketClient(baseUrl, {
    forceNew: true,
    reconnection: false,
    timeout: 5_000,
    transports: ["websocket"],
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
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

function waitForEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} was not received`)), 5_000);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test("Railway再起動後も、明示退出していないルームへ同じ端末から復帰できる", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-quiz-room-"));
  const stateFile = path.join(tempDir, "quiz-rooms.json");
  const sockets = [];
  const children = [];

  t.after(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    for (const child of children) await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const first = await startServer(stateFile);
  children.push(first.child);
  const host = await connect(first.baseUrl);
  const participant = await connect(first.baseUrl);
  sockets.push(host, participant);

  const room = await emitWithAck(host, "quiz:createRoom", { category: "clacel", name: "ホスト" });
  const entered = await emitWithAck(participant, "quiz:joinRoom", { roomCode: room.roomCode, name: "参加者" });
  assert.equal(fs.existsSync(stateFile), true, "ルーム作成直後に状態ファイルを作成する");

  host.disconnect();
  participant.disconnect();
  await stopServer(first.child);

  const second = await startServer(stateFile);
  children.push(second.child);
  const returningHost = await connect(second.baseUrl);
  const returningParticipant = await connect(second.baseUrl);
  sockets.push(returningHost, returningParticipant);

  const hostState = await emitWithAck(returningHost, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: room.playerId,
    sessionToken: room.sessionToken,
  });
  const participantState = await emitWithAck(returningParticipant, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: entered.playerId,
    sessionToken: entered.sessionToken,
  });
  assert.equal(hostState.ok, true);
  assert.equal(hostState.isHost, true);
  assert.equal(participantState.ok, true);
  assert.equal(participantState.isHost, false);

  returningHost.emit("quiz:leave");
  await delay(50);
  const roomInfo = await emitWithAck(returningParticipant, "quiz:roomInfo", { roomCode: room.roomCode });
  assert.match(roomInfo.error, /ルームが見つかりません/);
  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(persisted.rooms, {});
});

test("進行中のテストは再起動後も期限を復元し、期限到来時に未提出者を確定する", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-quiz-playing-room-"));
  const stateFile = path.join(tempDir, "quiz-rooms.json");
  const sockets = [];
  const children = [];

  t.after(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    for (const child of children) await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const first = await startServer(stateFile);
  children.push(first.child);
  const host = await connect(first.baseUrl);
  const participant = await connect(first.baseUrl);
  sockets.push(host, participant);

  const room = await emitWithAck(host, "quiz:createRoom", { category: "clacel", name: "ホスト" });
  const entered = await emitWithAck(participant, "quiz:joinRoom", { roomCode: room.roomCode, name: "参加者" });
  const started = waitForEvent(participant, "quiz:started");
  host.emit("quiz:startGame", { seriesIndex: 0 });
  await started;

  const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const persistedRoom = snapshot.rooms[room.roomCode];
  assert.equal(persistedRoom.phase, "playing");
  assert.equal(typeof persistedRoom.endsAt, "number");
  assert.ok(persistedRoom.endsAt > Date.now(), "開始時の期限を永続化する");

  // 本番の5分待機を避けつつ、再起動時に保存済みの期限からタイマーを組み直す経路を検証する。
  persistedRoom.endsAt = Date.now() + 5_000;
  fs.writeFileSync(stateFile, JSON.stringify(snapshot));

  host.disconnect();
  participant.disconnect();
  await stopServer(first.child);

  const second = await startServer(stateFile);
  children.push(second.child);
  const returningHost = await connect(second.baseUrl);
  const returningParticipant = await connect(second.baseUrl);
  sockets.push(returningHost, returningParticipant);

  const hostState = await emitWithAck(returningHost, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: room.playerId,
    sessionToken: room.sessionToken,
  });
  const participantState = await emitWithAck(returningParticipant, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: entered.playerId,
    sessionToken: entered.sessionToken,
  });
  assert.equal(hostState.phase, "playing");
  assert.equal(participantState.phase, "playing");
  assert.equal(hostState.endsAt, persistedRoom.endsAt);
  assert.equal(participantState.endsAt, persistedRoom.endsAt);
  assert.ok(Date.now() < persistedRoom.endsAt, "保存済みの期限前に両者が復帰できる");

  await delay(Math.max(0, persistedRoom.endsAt - Date.now() + 200));
  const forcedState = await emitWithAck(returningParticipant, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: entered.playerId,
    sessionToken: entered.sessionToken,
  });
  assert.equal(forcedState.submitted, true, "復元したタイマーが未提出者を0点で確定する");
});
