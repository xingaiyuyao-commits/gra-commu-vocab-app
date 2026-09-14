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

test("復習日の順位を7日間の再表示用データへ保存する", () => {
  const now = Date.parse("2026-09-04T10:30:01.000Z");
  const leaderboard = [
    { rank: 1, score: 50, total: 50, players: [{ id: "p1", name: "Kaho" }, { id: "p2", name: "Aica" }] },
    { rank: 2, score: 48, total: 50, players: [{ id: "p3", name: "Ryan" }] },
    { rank: 3, score: 47, total: 50, players: [{ id: "p4", name: "Nakayama" }] },
    { rank: 4, score: 46, total: 50, players: [{ id: "p5", name: "Miyu" }] },
    { rank: 5, score: 45, total: 50, players: [{ id: "p6", name: "Rina" }] },
    { rank: 6, score: 44, total: 50, players: [{ id: "p7", name: "Sora" }] },
  ];
  const saved = Saved.upsert("", { ...record("ABCD"), isReview: true, leaderboard }, now);
  const restored = Saved.find(saved.raw, "ABCD", now);

  assert.equal(restored.isReview, true);
  assert.deepEqual(restored.leaderboard, leaderboard.slice(0, 5));
});
