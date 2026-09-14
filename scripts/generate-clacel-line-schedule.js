#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { listScheduledDates, makeScheduledToken } = require("../scheduled-clacel-links");

function buildScheduleRows({ baseUrl, secret }) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  if (!origin) throw new Error("base URL is required");
  if (!secret) throw new Error("schedule link secret is required");
  return listScheduledDates().map((date) => {
    const calendarDate = new Date(`${date}T12:00:00+09:00`);
    const weekday = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" })
      .format(calendarDate).replace("曜日", "");
    const url = new URL("/quiz.html", origin);
    url.searchParams.set("mode", "scheduled");
    url.searchParams.set("date", date);
    url.searchParams.set("course", "clacel");
    url.searchParams.set("token", makeScheduledToken(date, secret));
    const day = Number(date.slice(-2));
    return {
      date,
      weekday,
      scheduledAt: `${date} 19:00`,
      url: url.toString(),
      message: `9月${day}日（${weekday}）のClacel単語テスト参加リンクです。\n19:30開始です。\n${url}`,
    };
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const header = ["date", "weekday", "scheduled_at", "url", "message"];
  const body = rows.map((row) => [row.date, row.weekday, row.scheduledAt, row.url, row.message]
    .map(csvCell).join(","));
  return `${header.join(",")}\n${body.join("\n")}\n`;
}

if (require.main === module) {
  const rows = buildScheduleRows({
    baseUrl: process.env.PUBLIC_BASE_URL,
    secret: process.env.SCHEDULE_LINK_SECRET,
  });
  const csv = toCsv(rows);
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error("--output requires a path");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, csv, { mode: 0o600 });
  } else {
    process.stdout.write(csv);
  }
}

module.exports = { buildScheduleRows, toCsv };
