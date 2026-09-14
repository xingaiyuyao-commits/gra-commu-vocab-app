const test = require("node:test");
const assert = require("node:assert/strict");

const { buildScheduleRows, toCsv } = require("../scripts/generate-clacel-line-schedule");

test("LINE予約用に17日分を19:00・日付順・重複なしで生成する", () => {
  const rows = buildScheduleRows({ baseUrl: "https://example.test", secret: "test-secret" });
  assert.equal(rows.length, 17);
  assert.deepEqual(
    { date: rows[0].date, weekday: rows[0].weekday, scheduledAt: rows[0].scheduledAt },
    { date: "2026-09-14", weekday: "月", scheduledAt: "2026-09-14 19:00" },
  );
  assert.deepEqual(
    { date: rows[16].date, weekday: rows[16].weekday, scheduledAt: rows[16].scheduledAt },
    { date: "2026-09-30", weekday: "水", scheduledAt: "2026-09-30 19:00" },
  );
  assert.equal(new Set(rows.map((row) => row.url)).size, 17);
  assert.match(rows[0].url, /^https:\/\/example\.test\/quiz\.html\?mode=scheduled&date=2026-09-14&course=clacel&token=/);
  assert.equal(rows[0].message, `9月14日（月）のClacel単語テスト参加リンクです。\n19:30開始です。\n${rows[0].url}`);
});

test("CSVは改行を含むLINE文面を壊さず出力する", () => {
  const csv = toCsv(buildScheduleRows({ baseUrl: "https://example.test", secret: "test-secret" }));
  const lines = csv.split("\n");
  assert.equal(lines[0], "date,weekday,scheduled_at,url,message");
  assert.match(csv, /"9月14日（月）のClacel単語テスト参加リンクです。\n19:30開始です。\nhttps:\/\/example\.test\//);
});

test("秘密値または本番URLがなければ生成しない", () => {
  assert.throws(() => buildScheduleRows({ baseUrl: "", secret: "test-secret" }), /base URL/);
  assert.throws(() => buildScheduleRows({ baseUrl: "https://example.test", secret: "" }), /secret/);
});
