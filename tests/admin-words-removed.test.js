const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

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

test("単語リスト編集ページとAPIは公開しない", async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: "unused" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.exitCode === null && child.kill("SIGTERM"));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    try {
      healthy = (await fetch(`${baseUrl}/healthz`)).status === 200;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(healthy, true, stderr);
  assert.equal((await fetch(`${baseUrl}/admin-words.html`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/admin/wordtests/clacel`)).status, 404);
});
