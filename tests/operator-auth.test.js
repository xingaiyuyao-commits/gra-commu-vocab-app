const test = require("node:test");
const assert = require("node:assert/strict");

const { createOperatorAuth } = require("../operator-auth");

const NOW = Date.parse("2026-09-04T10:00:00.000Z");

function auth(password = "correct horse battery staple", now = NOW) {
  return createOperatorAuth({
    password,
    secureCookie: true,
    now: () => now,
    randomBytes: () => Buffer.from("deterministic-nonce"),
  });
}

test("共有パスワードは正しい値だけをタイミングセーフに受理する", () => {
  const service = auth();
  assert.equal(service.passwordMatches("correct horse battery staple"), true);
  assert.equal(service.passwordMatches("wrong"), false);
  assert.equal(service.passwordMatches(null), false);
});

test("運営セッションは12時間以内だけ有効で、パスワード変更時に失効する", () => {
  const service = auth();
  const token = service.makeSessionToken();

  assert.equal(service.sessionTokenIsValid(token), true);
  assert.equal(auth("changed password").sessionTokenIsValid(token), false);
  assert.equal(auth("correct horse battery staple", NOW + 12 * 60 * 60 * 1000).sessionTokenIsValid(token), false);
  assert.equal(service.sessionTokenIsValid("broken"), false);
});

test("運営CookieはJavaScriptから読めず、本番でHTTPSと同一サイトに限定する", () => {
  const service = auth();
  const cookie = service.sessionCookie(service.makeSessionToken());

  assert.match(cookie, /^operator_session=/);
  assert.match(cookie, /Max-Age=43200/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /correct horse battery staple/);
});

test("Cookie列から運営セッションだけを取り出し、ログアウトCookieで削除する", () => {
  const service = auth();
  assert.equal(service.cookieToken("other=1; operator_session=abc.def.ghi; theme=dark"), "abc.def.ghi");
  assert.equal(service.cookieToken("other=1"), "");
  assert.match(service.clearCookie(), /^operator_session=; Max-Age=0;/);
});
