const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { io } = require("socket.io-client");

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

async function connect(baseUrl, cookie = "") {
  const socket = io(baseUrl, {
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

function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5_000);
    const callback = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  });
}

test("実サーバー: 開催者操作はログイン済みSocketだけに許可する", async (t) => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = "operator-test-password";
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), OPERATOR_PASSWORD: password },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(stderr);
    await delay(50);
  }

  const unauthorized = await connect(baseUrl);
  sockets.push(unauthorized);
  const rejected = await emit(unauthorized, "quiz:createRoom", { category: "clacel", name: "侵入者" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /運営者認証/);

  const login = await fetch(`${baseUrl}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const host = await connect(baseUrl, cookie);
  sockets.push(host);
  const room = await emit(host, "quiz:createRoom", { category: "clacel", name: "ホスト" });
  assert.equal(room.error, undefined);

  const fakeHost = await connect(baseUrl);
  sockets.push(fakeHost);
  const hostRejoin = await emit(fakeHost, "quiz:rejoin", {
    roomCode: room.roomCode,
    playerId: room.playerId,
    sessionToken: room.sessionToken,
  });
  assert.equal(hostRejoin.ok, false);
  assert.match(hostRejoin.error, /運営者認証/);

  const participant = await connect(baseUrl);
  sockets.push(participant);
  assert.equal((await emit(participant, "quiz:joinRoom", { roomCode: room.roomCode, name: "参加者" })).error, undefined);
  assert.deepEqual(await emit(host, "quiz:selectSeries", { seriesIndex: 1 }), { ok: true });
  assert.deepEqual(await emit(host, "quiz:startGame", { seriesIndex: 1 }), { ok: true });
  const rejectedCancel = await emit(participant, "quiz:cancelGame");
  assert.equal(rejectedCancel.ok, false);
  assert.deepEqual(await emit(host, "quiz:cancelGame"), { ok: true });
});
