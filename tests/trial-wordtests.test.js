const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { isDeepStrictEqual } = require("node:util");

const courses = {
  clacel: {
    data: require("../wordtests-clacel"),
    formalHash: "b06003e003ed1c63a92c585c996d7aee8530e624a23f0f958a0a306280ee23fc",
  },
  toeic: {
    data: require("../wordtests-toeic"),
    formalHash: "af38e281f62b5f81d2d8cc8ea82ef0c223a8e1224df58006e5f1ef1211a3788a",
  },
  ielts: {
    data: require("../wordtests-ielts"),
    formalHash: "9253ecf7a48de7cea38bca069b86be1f2d3c220c1f65c9a48b82cda41e58d745",
  },
};

function formalSeries(data) {
  return data.series.filter((series) => !series.isTrial);
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("体験会は各コースの正式教材を変えずに20問ずつ再利用する", () => {
  for (const [course, { data, formalHash }] of Object.entries(courses)) {
    const trial = data.series[0];
    assert.ok(trial, `${course}: 体験会シリーズがありません`);
    assert.equal(trial.name, "体験会", `${course}: 体験会は先頭に置きます`);
    assert.equal(trial.isTrial, true, `${course}: 体験会にisTrialを付けます`);
    assert.equal(trial.items.length, 20, `${course}: 体験会は20問です`);
    assert.equal(new Set(trial.items.map((item) => item.base)).size, 20, `${course}: 体験会のbaseは重複しません`);

    const formalItems = formalSeries(data).flatMap((series) => series.items);
    for (const item of trial.items) {
      assert.ok(formalItems.some((formalItem) => isDeepStrictEqual(item, formalItem)), `${course}: 体験会の問題は正式教材と完全一致します`);
    }
    assert.equal(hash(formalSeries(data)), formalHash, `${course}: 正式Dayの名前・順序・問題内容を変更しません`);
  }
});

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

async function waitForHealthy(baseUrl, child, getStderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(getStderr() || "test server exited");
    try {
      if ((await fetch(`${baseUrl}/healthz`)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server did not become healthy: ${getStderr() || "no stderr"}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("管理画面で保存しても体験会のisTrialを保持する", async (t) => {
  const sourceRoot = path.join(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(sourceRoot, ".tmp-osh-trial-wordtests-"));
  for (const file of ["server.js", "questions.js", "sentences.js", "wordtests-clacel.js", "wordtests-toeic.js", "wordtests-ielts.js", "wordtests.js"]) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(tempRoot, file));
  }
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: tempRoot,
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: "test-admin-password" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  await waitForHealthy(baseUrl, child, () => stderr);

  const headers = { "content-type": "application/json", "x-admin-password": "test-admin-password" };
  const original = await (await fetch(`${baseUrl}/api/admin/wordtests/clacel`, { headers })).json();
  assert.equal(original.series[0].isTrial, true, "体験会を含む単語帳を保存します");
  const invalid = structuredClone({ label: original.label, series: [original.series[0]] });
  invalid.series[0].isTrial = "true";
  const invalidSave = await fetch(`${baseUrl}/api/admin/wordtests/clacel`, {
    method: "POST",
    headers,
    body: JSON.stringify(invalid),
  });
  assert.equal(invalidSave.status, 400, "isTrialは真偽値だけを受け付けます");
  const save = await fetch(`${baseUrl}/api/admin/wordtests/clacel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: original.label, series: [original.series[0]] }),
  });
  assert.equal(save.status, 200);
  const saved = await (await fetch(`${baseUrl}/api/admin/wordtests/clacel`, { headers })).json();
  assert.equal(saved.series[0].isTrial, true);
});
