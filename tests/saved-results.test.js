const test = require("node:test");
const assert = require("node:assert/strict");
const Saved = require("../public/saved-results.js");

function record(roomCode, resultAt = "2026-09-04T10:30:00.000Z") {
  return {
    roomCode,
    category: "clacel",
    setLabel: "Clacel Day 1",
    resultAt,
    perfect: [{ id: "p1", name: "Kaho" }],
    review: [{ sentence: "Say ___.", answer: "hello", altAnswers: [], ja: "こんにちは", sentenceJa: "こんにちはと言う。" }],
    answers: ["helo"],
    playerId: "p2",
    isTrial: false,
  };
}

test("結果をルームコード単位で7日間保存し、同じルームは新しい内容へ置換する", () => {
  const now = Date.parse("2026-09-04T10:30:01.000Z");
  const first = Saved.upsert("", record("ABCD"), now);
  assert.equal(first.ok, true);
  assert.equal(Saved.find(first.raw, "abcd", now).answers[0], "helo");
  const changed = Saved.upsert(first.raw, { ...record("ABCD"), answers: ["hello"] }, now);
  assert.equal(Saved.parse(changed.raw, now).length, 1);
  assert.equal(Saved.find(changed.raw, "ABCD", now).answers[0], "hello");
});

test("7日を過ぎた結果と破損データは復元せず、保存件数を21件に制限する", () => {
  const now = Date.parse("2026-09-12T10:30:00.000Z");
  const expired = Saved.upsert("", record("ABCD"), Date.parse("2026-09-04T10:30:01.000Z"));
  assert.equal(Saved.find(expired.raw, "ABCD", now), null);
  assert.deepEqual(Saved.parse("{broken", now), []);

  let raw = "";
  const codeChars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let index = 0; index < 25; index += 1) {
    const code = `A${codeChars[index]}CD`;
    raw = Saved.upsert(raw, record(code, new Date(now - index * 1000).toISOString()), now).raw;
  }
  assert.equal(Saved.parse(raw, now).length, 21);
});

test("保存対象にセッショントークンや参加者名を含めない", () => {
  const now = Date.parse("2026-09-04T10:30:01.000Z");
  const saved = Saved.upsert("", { ...record("ABCD"), sessionToken: "secret", participantName: "Tina" }, now);
  assert.equal(saved.raw.includes("secret"), false);
  assert.equal(saved.raw.includes("Tina"), false);
});
