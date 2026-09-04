const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createHmac } = require("node:crypto");

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

async function startServer(t, {
  resultHistory = {},
  password,
  envOverrides = {},
  rawState = null,
  expectedHealthStatus = 200,
} = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-results-history-api-"));
  const stateDir = path.join(tempDir, "state");
  const stateFile = path.join(stateDir, "quiz-rooms.json");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(stateFile, rawState === null
    ? JSON.stringify({ version: 2, rooms: {}, resultHistory })
    : rawState);

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
      if (response.status === expectedHealthStatus) {
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
    questionStats: [],
    updatedAt: `${date}T11:00:00.000Z`,
    ...overrides,
  };
}

function signedResultsCookie(password, expiresAt) {
  const nonce = "deterministic-expired-token";
  const payload = `${expiresAt}.${nonce}`;
  const key = createHmac("sha256", password).update("results-history-session-v1").digest();
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `results_history_session=${payload}.${signature}`;
}

test("復元時に不正な問題集計を除外し、旧履歴は空配列として扱う", async (t) => {
  const record = historyRecord("2026-09-05", "clacel", {
    questionStats: [
      { questionId: "2026-09/clacel/day01/q01", attempts: 100, wrongCount: 12, reasonCounts: { spelling: 12 } },
      { questionId: "invalid id!", attempts: 100, wrongCount: 1, reasonCounts: { spelling: 1 } },
      { questionId: "2026-09/clacel/day01/q02", attempts: 2, wrongCount: 3, reasonCounts: { blank: 3 } },
      { questionId: "2026-09/clacel/day01/q03", attempts: 2, wrongCount: 1, reasonCounts: { unknown: 1 } },
    ],
  });
  const legacy = historyRecord("2026-09-06", "toeic");
  delete legacy.questionStats;
  const { stateFile } = await startServer(t, {
    resultHistory: {
      "2026-09-05:clacel": record,
      "2026-09-06:toeic": legacy,
    },
  });
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8")).resultHistory;
  assert.deepEqual(stored["2026-09-05:clacel"].questionStats, [record.questionStats[0]]);
  assert.deepEqual(stored["2026-09-06:toeic"].questionStats, []);
});

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

test("状態復元に失敗した場合は結果履歴APIを空の200として公開せず503にする", async (t) => {
  const { baseUrl } = await startServer(t, {
    password: "restore-failure-secret",
    rawState: "{broken-json",
    expectedHealthStatus: 503,
  });

  const loginResponse = await fetch(
    `${baseUrl}/api/results-history/login`,
    jsonRequest("POST", { password: "restore-failure-secret" })
  );
  assert.equal(loginResponse.status, 503);
  assert.equal(loginResponse.headers.get("cache-control"), "no-store");

  const historyResponse = await fetch(`${baseUrl}/api/results-history?month=2026-09`);
  assert.equal(historyResponse.status, 503);
  assert.equal(historyResponse.headers.get("cache-control"), "no-store");
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

test("非Railway環境では両IPヘッダーを偽装しても失敗制限を回避できない", async (t) => {
  const password = "local-proxy-secret";
  const { baseUrl } = await startServer(t, { password });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Forwarded-For"] = `198.51.100.${attempt}`;
    request.headers["X-Real-IP"] = `203.0.113.${attempt}`;
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }

  const bypass = jsonRequest("POST", { password });
  bypass.headers["X-Forwarded-For"] = "203.0.113.200";
  bypass.headers["X-Real-IP"] = "198.51.100.200";
  const limited = await fetch(`${baseUrl}/api/results-history/login`, bypass);
  assert.equal(limited.status, 429);
});

test("Railwayでは有効なX-Real-IPごとに失敗制限を分離する", async (t) => {
  const password = "railway-proxy-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { RAILWAY_ENVIRONMENT_ID: "railway-test" },
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Real-IP"] = "198.51.100.10";
    request.headers["X-Forwarded-For"] = "192.0.2.250";
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `client A attempt ${attempt}`);
  }

  const blockedRequest = jsonRequest("POST", { password });
  blockedRequest.headers["X-Real-IP"] = "198.51.100.10";
  blockedRequest.headers["X-Forwarded-For"] = "192.0.2.250";
  const blocked = await fetch(`${baseUrl}/api/results-history/login`, blockedRequest);
  assert.equal(blocked.status, 429, "client A remains limited");

  const independentRequest = jsonRequest("POST", { password });
  independentRequest.headers["X-Real-IP"] = "203.0.113.20";
  independentRequest.headers["X-Forwarded-For"] = "192.0.2.250";
  const independent = await fetch(`${baseUrl}/api/results-history/login`, independentRequest);
  assert.equal(independent.status, 200, "client B has an independent bucket");
  assert.match(responseCookie(independent).setCookie, /;\s*Secure/i, "Railway cookie remains Secure");
});

test("RailwayではX-Forwarded-Forを変えても同じX-Real-IPの失敗制限を回避できない", async (t) => {
  const password = "railway-ignore-xff-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { RAILWAY_ENVIRONMENT_ID: "railway-test" },
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Real-IP"] = "198.51.100.50";
    request.headers["X-Forwarded-For"] = `203.0.113.${attempt}, 192.0.2.250`;
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }

  const bypass = jsonRequest("POST", { password });
  bypass.headers["X-Real-IP"] = "198.51.100.50";
  bypass.headers["X-Forwarded-For"] = "203.0.113.200, 192.0.2.250";
  const limited = await fetch(`${baseUrl}/api/results-history/login`, bypass);
  assert.equal(limited.status, 429);
});

test("Railwayの空または不正なX-Real-IPは接続元へ集約して失敗制限を回避させない", async (t) => {
  const password = "railway-invalid-proxy-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { RAILWAY_ENVIRONMENT_ID: "railway-test" },
  });
  const malformedValues = [null, "", "not-an-ip", "999.999.999.999", "2001:db8:::bad"];

  for (const [index, realIp] of malformedValues.entries()) {
    const request = jsonRequest("POST", { password: "wrong" });
    if (realIp !== null) request.headers["X-Real-IP"] = realIp;
    request.headers["X-Forwarded-For"] = `203.0.113.${index + 1}`;
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `malformed attempt ${index + 1}`);
  }

  const bypass = jsonRequest("POST", { password });
  bypass.headers["X-Real-IP"] = "another-arbitrary-key";
  bypass.headers["X-Forwarded-For"] = "203.0.113.200";
  const limited = await fetch(`${baseUrl}/api/results-history/login`, bypass);
  assert.equal(limited.status, 429);
});

test("Railwayの同じIPv6クライアント表記を正規化して同じ失敗制限に数える", async (t) => {
  const password = "railway-ipv6-secret";
  const { baseUrl } = await startServer(t, {
    password,
    envOverrides: { RAILWAY_ENVIRONMENT_ID: "railway-test" },
  });
  const equivalentClientIps = [
    "2001:0DB8:0000:0000:0000:0000:0000:0001",
    "2001:db8:0:0:0:0:0:1",
    "2001:db8::1",
    "2001:0db8::1",
    "2001:DB8:0:0::1",
  ];

  for (const [index, clientIp] of equivalentClientIps.entries()) {
    const request = jsonRequest("POST", { password: "wrong" });
    request.headers["X-Real-IP"] = clientIp;
    request.headers["X-Forwarded-For"] = `203.0.113.${index + 1}`;
    const response = await fetch(`${baseUrl}/api/results-history/login`, request);
    assert.equal(response.status, 401, `IPv6 attempt ${index + 1}`);
  }

  const finalRequest = jsonRequest("POST", { password });
  finalRequest.headers["X-Real-IP"] = "2001:db8::1";
  finalRequest.headers["X-Forwarded-For"] = "203.0.113.200";
  const limited = await fetch(`${baseUrl}/api/results-history/login`, finalRequest);
  assert.equal(limited.status, 429);
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

test("正しい署名でも期限切れのCookieは実APIで拒否する", async (t) => {
  const password = "expired-cookie-secret";
  const { baseUrl } = await startServer(t, { password });
  const expiredCookie = signedResultsCookie(password, 1);

  const response = await fetch(`${baseUrl}/api/results-history?month=2026-09`, {
    headers: { Cookie: expiredCookie },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
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
  const { questionStats: _privateStats, ...publicOriginal } = original;
  assert.deepEqual(await afterFailure.json(), [publicOriginal]);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).resultHistory, { [key]: original });
});
