const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
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

function chromeExecutable() {
  const commands = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const command of commands) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;
  throw new Error("Chrome executable was not found");
}

async function waitForHealthy(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("test server exited early");
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error("test server did not become healthy");
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function waitForDevtools(userDataDir, child) {
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Chrome exited early");
    if (fs.existsSync(activePortFile)) {
      try {
        const [port] = fs.readFileSync(activePortFile, "utf8").split("\n");
        if (/^\d+$/.test(port)) {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (response.ok) {
            const pages = await response.json();
            const page = pages.find((entry) => entry.type === "page");
            if (page) return page.webSocketDebuggerUrl;
          }
        }
      } catch { /* Chrome may still be writing the port file or opening DevTools. */ }
    }
    await delay(50);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

function connectDevtools(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    socket,
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
  };
}

test("PCホームは1440×800で主要内容が縦スクロールなしに収まる", async (t) => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "osh-home-chrome-"));
  let chrome;
  let devtools;
  t.after(async () => {
    devtools?.socket.close();
    await stop(chrome);
    await stop(server);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  await waitForHealthy(baseUrl, server);
  chrome = spawn(chromeExecutable(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,800",
    baseUrl,
  ], { stdio: "ignore" });
  devtools = connectDevtools(await waitForDevtools(userDataDir, chrome));

  const deadline = Date.now() + 10_000;
  let metrics;
  while (Date.now() < deadline) {
    const result = await devtools.send("Runtime.evaluate", {
      expression: `(() => ({
        ready: document.readyState,
        innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        titleTop: document.querySelector('h1')?.getBoundingClientRect().top,
        operatorBottom: document.querySelector('.operator-link')?.getBoundingClientRect().bottom,
        imageBottom: document.querySelector('.home-illustration img')?.getBoundingClientRect().bottom,
        manualJoinLink: document.querySelector('a[href="/quiz.html?mode=join"]')
      }))()`,
      returnByValue: true,
    });
    metrics = result?.result?.value;
    if (metrics?.ready === "complete" && metrics.operatorBottom) break;
    await delay(50);
  }

  assert.ok(metrics, "Chrome did not return page metrics before the deadline");
  assert.equal(metrics.scrollWidth, metrics.innerWidth, "横スクロールがない");
  assert.ok(metrics.scrollHeight <= metrics.innerHeight, `縦スクロールあり: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.titleTop >= 24, `タイトル上に24px以上の余白がある: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.manualJoinLink, null, "ルームコード手入力リンクがない");
  assert.ok(metrics.operatorBottom <= metrics.innerHeight, "運営用リンクが一画面内にある");
  assert.ok(metrics.imageBottom <= metrics.innerHeight, "メイン画像が一画面内にある");
  const contentBottom = Math.max(metrics.operatorBottom, metrics.imageBottom);
  const bottomSpace = metrics.innerHeight - contentBottom;
  assert.ok(
    Math.abs(metrics.titleTop - bottomSpace) <= 24,
    `コンテンツ全体の上下余白差が24px以内: ${JSON.stringify({ titleTop: metrics.titleTop, bottomSpace })}`,
  );

  const visibleDayResult = await devtools.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('.today-card').removeAttribute('hidden');
      document.querySelector('#today-date').textContent = '9月6日';
      document.querySelector('#today-day').textContent = 'Day 1';
      return {
        innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        titleTop: document.querySelector('h1')?.getBoundingClientRect().top,
        operatorBottom: document.querySelector('.operator-link')?.getBoundingClientRect().bottom,
        imageBottom: document.querySelector('.home-illustration img')?.getBoundingClientRect().bottom
      };
    })()`,
    returnByValue: true,
  });
  const visibleDayMetrics = visibleDayResult?.result?.value;
  assert.ok(
    visibleDayMetrics.scrollHeight <= visibleDayMetrics.innerHeight,
    `学習日カード表示時も縦スクロールがない: ${JSON.stringify(visibleDayMetrics)}`,
  );
  assert.ok(visibleDayMetrics.operatorBottom <= visibleDayMetrics.innerHeight, "学習日カード表示時も運営用リンクが一画面内にある");
  assert.ok(visibleDayMetrics.imageBottom <= visibleDayMetrics.innerHeight, "学習日カード表示時もメイン画像が一画面内にある");
  const visibleDayBottom = Math.max(visibleDayMetrics.operatorBottom, visibleDayMetrics.imageBottom);
  const visibleDayBottomSpace = visibleDayMetrics.innerHeight - visibleDayBottom;
  assert.ok(
    Math.abs(visibleDayMetrics.titleTop - visibleDayBottomSpace) <= 24,
    `学習日カード表示時も上下余白差が24px以内: ${JSON.stringify({ titleTop: visibleDayMetrics.titleTop, bottomSpace: visibleDayBottomSpace })}`,
  );
});
