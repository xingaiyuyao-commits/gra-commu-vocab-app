const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

function runLoadScript() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/test-quiz-load.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, QUIZ_LOAD_TIMEOUT_MS: "60000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`load script timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 75_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("負荷スクリプトは実Socket.IOで1ホストと99参加者を完走し、v2履歴と誤答上位3件を保存する", { timeout: 80_000 }, async () => {
  const result = await runLoadScript();
  assert.equal(
    result.code,
    0,
    `load script failed (signal: ${result.signal || "none"})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.equal(result.stderr, "");

  const summary = JSON.parse(result.stdout.trim());
  assert.deepEqual(summary.connections, { hosts: 1, participants: 99 });
  assert.deepEqual(summary.actions, { joined: 99, submitted: 99, resultRevealed: true });
  assert.deepEqual(
    summary.topMistakes.map(({ index, count }) => ({ index, count })),
    [
      { index: 0, count: 98 },
      { index: 1, count: 75 },
      { index: 2, count: 50 },
    ]
  );
  assert.deepEqual(summary.history, {
    stateVersion: 2,
    key: "2042-01-02:clacel",
    participantCount: 99,
    perfectNames: ["Load-001"],
  });
});
