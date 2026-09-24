const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participation-counts-"));
  const stateFile = path.join(dir, "quiz-rooms.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 2,
    rooms: {},
    resultHistory: {
      "2026-09-24:clacel": {
        date: "2026-09-24", category: "clacel", participantCount: 28,
        perfectNames: ["private name"], questionStats: [], setLabel: "private label",
      },
      "2026-09-24:toeic": {
        date: "2026-09-24", category: "toeic", participantCount: 20,
        perfectNames: ["another name"], questionStats: [],
      },
      "2026-08-24:ielts": {
        date: "2026-08-24", category: "ielts", participantCount: 9,
        questionStats: [],
      },
    },
  }));
  const probe = net.createServer();
  const port = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  }));
  const env = { ...process.env, PORT: String(port), QUIZ_ROOM_STATE_FILE: stateFile };
  delete env.RAILWAY_ENVIRONMENT_ID;
  delete env.RAILWAY_SERVICE_ID;
  delete env.RAILWAY_PROJECT_ID;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."), env, stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("server exited early");
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return baseUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not start");
}

test("public attendance feed returns counts only", async (t) => {
  const baseUrl = await startServer(t);
  const endpoint = `${baseUrl}/api/participation-counts?month=2026-09`;
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const records = await response.json();
  assert.deepEqual(records, [
    { date: "2026-09-24", category: "clacel", participantCount: 28 },
    { date: "2026-09-24", category: "toeic", participantCount: 20 },
  ]);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal((await fetch(`${baseUrl}/api/participation-counts?month=2026-13`)).status, 400);
});
