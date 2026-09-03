const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

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

async function startServer(t, { resultHistory = {}, password, envOverrides = {} } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-results-history-api-"));
  const stateDir = path.join(tempDir, "state");
  const stateFile = path.join(stateDir, "quiz-rooms.json");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, rooms: {}, resultHistory }));

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    QUIZ_ROOM_STATE_FILE: stateFile,
  };
  for (const name of [
    "RESULTS_ADMIN_PASSWORD",
    "NODE_ENV",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_PROJECT_ID",
  ]) delete env[name];
  if (password !== undefined) env.RESULTS_ADMIN_PASSWORD = password;
  Object.assign(env, envOverrides);

  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
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
      if (response.status === 200) {
        t.after(async () => {
          await stopServer(child);
          fs.rmSync(tempDir, { recursive: true, force: true });
        });
        return { child, baseUrl, tempDir, stateDir, stateFile };
      }
    } catch {}
    await delay(50);
  }
  await stopServer(child);
  fs.rmSync(tempDir, { recursive: true, force: true });
  throw new Error(`test server did not become healthy: ${stderr || "no stderr"}`);
}

function jsonRequest(method, body, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

function responseCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Set-Cookie header is required");
  return { setCookie, cookie: setCookie.split(";", 1)[0] };
}

async function login(baseUrl, password) {
  const response = await fetch(
    `${baseUrl}/api/results-history/login`,
    jsonRequest("POST", { password })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  return responseCookie(response);
}

function historyRecord(date, category, overrides = {}) {
  return {
    date,
    category,
    setLabel: `${category} Day 1`,
    participantCount: 3,
    perfectNames: ["Miki"],
    updatedAt: `${date}T11:00:00.000Z`,
    ...overrides,
  };
}

test("専用パスワード未設定時は全履歴APIを503にして公開しない", async (t) => {
  const { baseUrl } = await startServer(t);
  const requests = [
    fetch(`${baseUrl}/api/results-history/login`, jsonRequest("POST", { password: "anything" })),
    fetch(`${baseUrl}/api/results-history?month=2026-09`),
    fetch(`${baseUrl}/api/results-history/2026-09-05/clacel`, { method: "DELETE" }),
    fetch(`${baseUrl}/api/results-history/logout`, { method: "POST" }),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("誤パスワードをIP単位で制限し、入力値を応答や永続状態へ残さない", async (t) => {
  const password = "correct horse battery staple";
  const attempted = "wrong-password-that-must-not-leak";
  const { baseUrl, stateFile } = await startServer(t, { password });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/results-history/login`,
      jsonRequest("POST", { password: attempted })
    );
    assert.equal(response.status, 401, `attempt ${attempt}`);
    assert.equal((await response.text()).includes(attempted), false);
  }

  const limited = await fetch(
    `${baseUrl}/api/results-history/login`,
    jsonRequest("POST", { password })
  );
  assert.equal(limited.status, 429);
  const limitedBody = await limited.text();
  assert.equal(limitedBody.includes(password), false);
  assert.equal(limitedBody.includes(attempted), false);
  assert.equal(fs.readFileSync(stateFile, "utf8").includes(attempted), false);
  assert.equal(fs.readFileSync(stateFile, "utf8").includes(password), false);
});

test("非Railway環境ではX-Forwarded-Forを偽装しても失敗制限を回避できない", async (t) => {
  const password = "local-proxy-secret";
  const { baseUrl } = await startServer(t, { password });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Forwarded-For"] = `198.51.100.${attempt}`;
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }

  const bypass = jsonRequest("POST", { password });
  bypass.headers["X-Forwarded-For"] = "203.0.113.200";
  const limited = await fetch(`${baseUrl}/api/results-history/login`, bypass);
  assert.equal(limited.status, 429);
});

test("Railwayの1段プロキシでは転送されたクライアントIPごとに失敗制限を分離する", async (t) => {
  const password = "railway-proxy-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { RAILWAY_ENVIRONMENT_ID: "railway-test" },
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Forwarded-For"] = "198.51.100.10";
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `client A attempt ${attempt}`);
  }

  const blockedRequest = jsonRequest("POST", { password });
  blockedRequest.headers["X-Forwarded-For"] = "198.51.100.10";
  const blocked = await fetch(`${baseUrl}/api/results-history/login`, blockedRequest);
  assert.equal(blocked.status, 429, "client A remains limited");

  const independentRequest = jsonRequest("POST", { password });
  independentRequest.headers["X-Forwarded-For"] = "203.0.113.20";
  const independent = await fetch(`${baseUrl}/api/results-history/login`, independentRequest);
  assert.equal(independent.status, 200, "client B has an independent bucket");
  assert.match(responseCookie(independent).setCookie, /;\s*Secure/i, "Railway cookie remains Secure");
});

test("ログインCookieで指定月の許可フィールドだけを取得できる", async (t) => {
  const password = "history-admin-secret";
  const septemberClacel = historyRecord("2026-09-05", "clacel", {
    setLabel: "Clacel 体験会",
    participantCount: 32,
    perfectNames: ["Aica", "Miki"],
    timeMs: 123,
    others: [{ name: "private participant", score: 19 }],
    internalSecret: "must not be returned",
  });
  const septemberToeic = historyRecord("2026-09-30", "toeic", {
    setLabel: "TOEIC Day 25",
    perfectNames: [],
  });
  const octoberIelts = historyRecord("2026-10-01", "ielts");
  const { baseUrl, stateFile } = await startServer(t, {
    password,
    resultHistory: {
      "2026-10-01:ielts": octoberIelts,
      "2026-09-30:toeic": septemberToeic,
      "2026-09-05:clacel": septemberClacel,
    },
  });

  const unauthenticated = await fetch(`${baseUrl}/api/results-history?month=2026-09`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");

  const { setCookie, cookie } = await login(baseUrl, password);
  assert.match(setCookie, /Max-Age=43200/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);
  assert.doesNotMatch(setCookie, /;\s*Secure/i, "local HTTP tests may use a non-Secure cookie");
  assert.equal(setCookie.includes(password), false);
  assert.equal(fs.readFileSync(stateFile, "utf8").includes(password), false);

  const response = await fetch(`${baseUrl}/api/results-history?month=2026-09`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), [
    {
      date: "2026-09-05",
      category: "clacel",
      setLabel: "Clacel 体験会",
      participantCount: 32,
      perfectNames: ["Aica", "Miki"],
      updatedAt: "2026-09-05T11:00:00.000Z",
    },
    {
      date: "2026-09-30",
      category: "toeic",
      setLabel: "TOEIC Day 25",
      participantCount: 3,
      perfectNames: [],
      updatedAt: "2026-09-30T11:00:00.000Z",
    },
  ]);

  for (const invalidMonth of ["2026-9", "2026-13", "not-a-month", ""]) {
    const invalid = await fetch(
      `${baseUrl}/api/results-history${invalidMonth ? `?month=${invalidMonth}` : ""}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(invalid.status, 400, invalidMonth || "missing month");
  }

  const [name, value] = cookie.split("=");
  const tampered = await fetch(`${baseUrl}/api/results-history?month=2026-09`, {
    headers: { Cookie: `${name}=${value.slice(0, -1)}x` },
  });
  assert.equal(tampered.status, 401);
});

test("本番ログインCookieだけにSecure属性を付ける", async (t) => {
  const password = "production-admin-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { NODE_ENV: "production" },
  });

  const { setCookie } = await login(baseUrl, password);
  assert.match(setCookie, /;\s*Secure/i);
});

test("認証済み削除を原子的に保存し、ログアウトでCookieを失効させる", async (t) => {
  const password = "delete-admin-secret";
  const key = "2026-09-05:clacel";
  const { baseUrl, stateFile } = await startServer(t, {
    password,
    resultHistory: { [key]: historyRecord("2026-09-05", "clacel") },
  });
  const { cookie } = await login(baseUrl, password);

  const invalidDelete = await fetch(`${baseUrl}/api/results-history/2026-09-31/clacel`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(invalidDelete.status, 400);
  assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).resultHistory[key]);

  const deleted = await fetch(`${baseUrl}/api/results-history/2026-09-05/clacel`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal(deleted.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).resultHistory, {});

  const logout = await fetch(`${baseUrl}/api/results-history/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  const expired = responseCookie(logout);
  assert.match(expired.setCookie, /Max-Age=0/i);
  assert.match(expired.setCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
  assert.match(expired.setCookie, /HttpOnly/i);
  assert.match(expired.setCookie, /SameSite=Strict/i);
  assert.match(expired.setCookie, /Path=\//i);

  const afterLogout = await fetch(`${baseUrl}/api/results-history?month=2026-09`, {
    headers: { Cookie: expired.cookie },
  });
  assert.equal(afterLogout.status, 401);
});

test("削除の永続化失敗時は履歴をメモリ上でもロールバックする", async (t) => {
  const password = "rollback-admin-secret";
  const key = "2026-09-05:clacel";
  const original = historyRecord("2026-09-05", "clacel", { participantCount: 9 });
  const { baseUrl, stateDir, stateFile, tempDir } = await startServer(t, {
    password,
    resultHistory: { [key]: original },
  });
  const { cookie } = await login(baseUrl, password);

  const backupDir = path.join(tempDir, "state-backup");
  fs.renameSync(stateDir, backupDir);
  fs.writeFileSync(stateDir, "block persistence");

  const failed = await fetch(`${baseUrl}/api/results-history/2026-09-05/clacel`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "no-store");

  fs.rmSync(stateDir, { force: true });
  fs.renameSync(backupDir, stateDir);
  const afterFailure = await fetch(`${baseUrl}/api/results-history?month=2026-09`, {
    headers: { Cookie: cookie },
  });
  assert.equal(afterFailure.status, 200);
  assert.deepEqual(await afterFailure.json(), [original]);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).resultHistory, { [key]: original });
});
