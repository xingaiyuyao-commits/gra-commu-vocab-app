#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { selectReviewQuestions } = require("../quiz-review-selection");

const COURSE_FILES = {
  clacel: "clacel-2026-09.json",
  toeic: "toeic-2026-09.json",
  ielts: "ielts-2026-09.json",
};

function seededRandom(seedText) {
  let state = createHash("sha256").update(seedText).digest().readUInt32LE(0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function inferredDay(record) {
  const days = new Set((record?.questionStats || []).flatMap((stat) => {
    const match = /\/day(\d+)\//i.exec(String(stat?.questionId || ""));
    return match ? [Number(match[1])] : [];
  }));
  return days.size === 1 ? [...days][0] : null;
}

function normalizedHistory(resultHistory) {
  return Object.fromEntries(Object.entries(resultHistory || {}).map(([key, record]) => [key, {
    ...record,
    day: Number(record?.day) || inferredDay(record),
  }]));
}

function main() {
  const [stateFile, reviewDayText = "7", outputFile = path.join(__dirname, "..", "data", "wordtests", "review-2026-09.json")] = process.argv.slice(2);
  if (!stateFile) throw new Error("usage: build-fixed-review-set.js STATE_FILE [REVIEW_DAY] [OUTPUT_FILE]");
  const reviewDay = Number(reviewDayText);
  const sourceDays = Array.from({ length: 6 }, (_, index) => reviewDay - 6 + index);
  const reviewDate = new Date(Date.UTC(2026, 8, 5 + reviewDay)).toISOString().slice(0, 10);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const resultHistory = normalizedHistory(state.resultHistory);
  const existing = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, "utf8")) : { month: "2026-09", days: {} };
  const courses = {};

  for (const [category, filename] of Object.entries(COURSE_FILES)) {
    const data = require(path.join(__dirname, "..", "data", "wordtests", filename));
    const result = selectReviewQuestions({
      category,
      reviewDay,
      datasetRevision: data.datasetRevision,
      sourceDays,
      series: data.series,
      resultHistory,
      random: seededRandom(`2026-09/${category}/day${reviewDay}`),
    });
    courses[category] = {
      datasetRevision: data.datasetRevision,
      questionIds: result.questions.map(({ questionId }) => questionId),
    };
  }

  existing.days[String(reviewDay)] = {
    date: reviewDate,
    sourceDays,
    courses,
  };
  fs.writeFileSync(outputFile, `${JSON.stringify(existing, null, 2)}\n`);
}

main();
