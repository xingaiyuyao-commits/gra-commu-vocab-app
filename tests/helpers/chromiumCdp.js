"use strict";

// Real Chrome, real trusted input events. Runtime.evaluate is used only for
// observation, scrolling, and focus; never to fill answers or trigger app code.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeExecutable() {
  if (process.env.CHROME_BIN) {
    assert.ok(fs.existsSync(process.env.CHROME_BIN), "CHROME_BIN must identify an existing Chrome executable");
    return process.env.CHROME_BIN;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  throw new Error("Real Chrome is required for PDF learner acceptance; install Chrome or set CHROME_BIN (this test never falls back to jsdom or skips).");
}

async function stopProcess(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

function connectDevtools(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const exceptions = [];
  let nextId = 1;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome DevTools WebSocket connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Chrome DevTools connection closed"));
    }
    pending.clear();
  });
  return {
    socket,
    exceptions,
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools ${method} timed out`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function startChrome(userDataDir) {
  const child = spawn(chromeExecutable(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`, "--window-size=1440,1000", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-12_000); });
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  try {
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    let debuggerUrl;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited early: ${stderr}`);
      try {
        const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
        if (/^\d+$/.test(port)) {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
          const pages = await response.json();
          debuggerUrl = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
          if (debuggerUrl) break;
        }
      } catch {}
      await delay(50);
    }
    assert.ok(debuggerUrl, `Chrome DevTools did not become ready: ${stderr}`);
    const cdp = connectDevtools(debuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    async function evaluate(expression) {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    }

    async function waitFor(expression, label = expression, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(25);
      }
      const state = await evaluate(`({url: location.href, screen: document.querySelector('.screen.active')?.id,
        question: document.querySelector('#q-num')?.textContent, error: document.querySelector('#entry-error')?.textContent})`);
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
    }

    async function click(selector) {
      const encoded = JSON.stringify(selector);
      await waitFor(`(() => { const el = document.querySelector(${encoded});
        return Boolean(el && !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); })()`, selector);
      const point = await evaluate(`(() => {
        const el = document.querySelector(${encoded});
        el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return {x, y, unobstructed: top === el || el.contains(top)};
      })()`);
      assert.ok(point.unobstructed, `${selector} must be reachable by a real pointer`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    }

    async function type(selector, text) {
      await click(selector);
      const selectAllModifier = process.platform === "darwin" ? 4 : 2;
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: selectAllModifier, windowsVirtualKeyCode: 65 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: selectAllModifier, windowsVirtualKeyCode: 65 });
      // Browser-level IME/text input dispatches trusted beforeinput/input events.
      // It does not assign .value or invoke saveCurrent/submitQuiz from JavaScript.
      await cdp.send("Input.insertText", { text });
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text, `${selector} typed text`);
    }

    async function navigate(url) {
      await cdp.send("Page.navigate", { url });
      await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, `navigation to ${url}`);
    }

    async function reload() {
      const before = await evaluate("performance.timeOrigin");
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitFor(`performance.timeOrigin !== ${before} && document.readyState === 'complete'`, "a fresh page after reload");
    }

    return {
      cdp, evaluate, waitFor, click, type, navigate, reload,
      screen: (id) => waitFor(`document.getElementById(${JSON.stringify(id)})?.classList.contains('active')`, id),
      async screenshot(destination) {
        const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 } });
        fs.writeFileSync(destination, Buffer.from(data, "base64"));
      },
      async close() { cdp.socket.close(); await stopProcess(child); },
    };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

module.exports = { startChrome, stopProcess, delay };
