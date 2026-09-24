const { createHmac, timingSafeEqual } = require("node:crypto");

const SCHEDULE_START_DATE = "2026-09-14";
const SCHEDULE_END_DATE = "2026-09-30";
const SCHEDULED_COURSES = Object.freeze(["clacel", "toeic", "ielts"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function listScheduledDates() {
  const dates = [];
  for (let day = 14; day <= 30; day += 1) dates.push(`2026-09-${String(day).padStart(2, "0")}`);
  return dates;
}

function scheduledDateIsValid(date) {
  return DATE_PATTERN.test(String(date || ""))
    && date >= SCHEDULE_START_DATE
    && date <= SCHEDULE_END_DATE;
}

function scheduledCourseIsValid(course) {
  return SCHEDULED_COURSES.includes(String(course || ""));
}

function makeScheduledToken(date, secret, course = "clacel") {
  if (!scheduledDateIsValid(date) || !secret || !scheduledCourseIsValid(course)) return "";
  return createHmac("sha256", secret)
    .update(`${course}:${date}:v1`)
    .digest("base64url");
}

function verifyScheduledToken(date, token, secret, course = "clacel") {
  if (!scheduledDateIsValid(date) || !scheduledCourseIsValid(course) || typeof token !== "string" || !token || !secret) return false;
  const expected = Buffer.from(makeScheduledToken(date, secret, course));
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function tokyoDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function scheduledDateState(date, now = new Date()) {
  if (!scheduledDateIsValid(date)) return "out-of-range";
  const today = tokyoDateKey(now);
  if (date > today) return "future";
  if (date < today) return "expired";
  return "today";
}

module.exports = {
  SCHEDULE_START_DATE,
  SCHEDULE_END_DATE,
  SCHEDULED_COURSES,
  listScheduledDates,
  makeScheduledToken,
  verifyScheduledToken,
  scheduledDateIsValid,
  scheduledCourseIsValid,
  scheduledDateState,
  tokyoDateKey,
};
