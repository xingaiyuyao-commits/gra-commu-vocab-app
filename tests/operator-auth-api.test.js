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

async function startServer(t, { password, railway = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-operator-api-"));
  const stateFile = path.join(tempDir, "quiz-rooms.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, rooms: {}, resultHistory: {} }));
  const port = await reservePort();
  const env = { ...process.env, PORT: String(port), QUIZ_ROOM_STATE_FILE: stateFile };
  delete env.OPERATOR_PASSWORD;
  delete env.RAILWAY_ENVIRONMENT_ID;
  if (password !== undefined) env.OPERATOR_PASSWORD = password;
  if (railway) env.RAILWAY_ENVIRONMENT_ID = "test-railway";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "ignore", "pipe"],
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
      if ((await fetch(`${baseUrl}/healthz`)).status === 200) return baseUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

function post(baseUrl, pathName, body, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST", headers, body: JSON.stringify(body || {}),
  });
}

test("運営パスワード未設定時は認証APIを公開状態へフォールバックしない", async (t) => {
  const baseUrl = await startServer(t);
  for (const response of await Promise.all([
    post(baseUrl, "/api/operator/login", { password: "anything" }),
    fetch(`${baseUrl}/api/operator/session`),
    post(baseUrl, "/api/operator/logout"),
  ])) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("共有パスワードで12時間Cookieを発行し、セッション確認とログアウトができる", async (t) => {
  const baseUrl = await startServer(t, { password: "strong shared password", railway: true });
  const wrong = await post(baseUrl, "/api/operator/login", { password: "wrong" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "認証に失敗しました" });

  const login = await post(baseUrl, "/api/operator/login", { password: "strong shared password" });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /operator_session=/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];

  const session = await fetch(`${baseUrl}/api/operator/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });

  const logout = await post(baseUrl, "/api/operator/logout", {}, cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /operator_session=; Max-Age=0/);
});

test("同じ接続元の誤入力を5回で一時制限する", async (t) => {
  const baseUrl = await startServer(t, { password: "strong shared password" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await post(baseUrl, "/api/operator/login", { password: "wrong" })).status, 401);
  }
  assert.equal((await post(baseUrl, "/api/operator/login", { password: "strong shared password" })).status, 429);
});
