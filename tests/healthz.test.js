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

test("Railwayのヘルスチェックに200を返す", async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  let exited = false;
  child.once("exit", () => { exited = true; });

  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  });

  let response;
  const deadline = Date.now() + 30_000;
  while (!response && !exited && Date.now() < deadline) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(response, `test server did not become healthy: ${stderr || "no stderr"}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
