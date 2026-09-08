const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "operator-login.html"), "utf8");

async function loadLogin(response) {
  const requests = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/operator-login.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return {
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          json: async () => response.body,
        };
      };
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return { dom, document: dom.window.document, requests };
}

test("運営者ログインは共有パスワードだけを送り、ブラウザ保存を使わない", async () => {
  const { dom, document, requests } = await loadLogin({ status: 401, body: { authenticated: false } });
  const input = document.getElementById("operator-password");
  input.value = "shared secret";
  document.getElementById("operator-login-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  const loginRequest = requests.find((request) => request.url === "/api/operator/login");
  assert.deepEqual(JSON.parse(loginRequest.options.body), { password: "shared secret" });
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
  dom.window.close();
});

test("運営者ログイン失敗を画面内に表示する", async () => {
  const { dom, document } = await loadLogin({ status: 401, body: { error: "認証に失敗しました" } });
  document.getElementById("operator-password").value = "wrong";
  document.getElementById("operator-login-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(document.getElementById("operator-login-error").textContent, "認証に失敗しました");
  dom.window.close();
});

test("運営者ログイン成功後はホームを経由せず開催画面へ移動する", async () => {
  const document = new JSDOM(html).window.document;
  const script = [...document.querySelectorAll("script")].at(-1).textContent;
  let onSubmit;
  const replaced = [];
  const elements = {
    "operator-login-form": { addEventListener: (_event, handler) => { onSubmit = handler; } },
    "operator-password": { value: "shared secret" },
    "operator-login-button": { disabled: false },
    "operator-login-error": { textContent: "" },
  };
  const fetch = async (url) => ({
    ok: url === "/api/operator/login",
    status: url === "/api/operator/login" ? 200 : 401,
    json: async () => ({}),
  });

  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements[id] },
    fetch,
    location: { replace: (url) => replaced.push(url) },
    JSON,
  });
  await onSubmit({ preventDefault() {} });

  assert.deepEqual(replaced, ["/quiz.html?mode=create"]);
});
