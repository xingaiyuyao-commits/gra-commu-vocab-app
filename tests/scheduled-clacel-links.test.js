const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SCHEDULE_START_DATE,
  SCHEDULE_END_DATE,
  listScheduledDates,
  makeScheduledToken,
  verifyScheduledToken,
  scheduledDateState,
} = require("../scheduled-clacel-links");

test("LINE予約用の日付を9月14日から30日まで17日分だけ列挙する", () => {
  assert.equal(SCHEDULE_START_DATE, "2026-09-14");
  assert.equal(SCHEDULE_END_DATE, "2026-09-30");
  assert.deepEqual(listScheduledDates(), [
    "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
    "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
    "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28",
    "2026-09-29", "2026-09-30",
  ]);
});

test("Clacelの日付に対して再現可能な署名を作成する", () => {
  assert.equal(
    makeScheduledToken("2026-09-14", "test-secret"),
    "b_O4MoWsASsHDP_-q6-14mlTciS26ark2sgdw-2yMa4",
  );
});

test("正しい署名だけを受理し日付・署名・対象範囲の改変を拒否する", () => {
  const token = "b_O4MoWsASsHDP_-q6-14mlTciS26ark2sgdw-2yMa4";
  assert.equal(verifyScheduledToken("2026-09-14", token, "test-secret"), true);
  assert.equal(verifyScheduledToken("2026-09-15", token, "test-secret"), false);
  assert.equal(verifyScheduledToken("2026-09-14", `${token}x`, "test-secret"), false);
  assert.equal(verifyScheduledToken("2026-10-01", token, "test-secret"), false);
  assert.equal(verifyScheduledToken("2026-09-14", token, ""), false);
});

test("東京の日付を基準に未来・当日・過去を判定する", () => {
  const beforeMidnightUtc = new Date("2026-09-13T14:59:59.000Z");
  const midnightUtc = new Date("2026-09-13T15:00:00.000Z");

  assert.equal(scheduledDateState("2026-09-14", beforeMidnightUtc), "future");
  assert.equal(scheduledDateState("2026-09-14", midnightUtc), "today");
  assert.equal(scheduledDateState("2026-09-13", midnightUtc), "out-of-range");
  assert.equal(scheduledDateState("2026-09-14", new Date("2026-09-14T15:00:00.000Z")), "expired");
  assert.equal(scheduledDateState("not-a-date", midnightUtc), "out-of-range");
});
