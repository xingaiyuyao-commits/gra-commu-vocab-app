(function attachSavedResults(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizSavedResults = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSavedResults() {
  "use strict";

  const STORAGE_KEY = "oshQuizSavedResultsV1";
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_RECORDS = 21;
  const CATEGORIES = new Set(["clacel", "toeic", "ielts"]);

  function normalizeRecord(value, now = Date.now()) {
    if (!value || typeof value !== "object") return null;
    const roomCode = String(value.roomCode || "").trim().toUpperCase();
    const category = String(value.category || "");
    const resultAtMs = Date.parse(value.resultAt);
    const expiresAtMs = Number(value.expiresAt) || resultAtMs + RETENTION_MS;
    if (!/^[A-Z2-9]{4}$/.test(roomCode)
      || !CATEGORIES.has(category)
      || !Number.isFinite(resultAtMs)
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= now
      || !Array.isArray(value.review)
      || !Array.isArray(value.answers)
      || value.review.length !== value.answers.length) return null;
    return {
      roomCode,
      category,
      setLabel: String(value.setLabel || ""),
      resultAt: new Date(resultAtMs).toISOString(),
      expiresAt: expiresAtMs,
      perfect: Array.isArray(value.perfect)
        ? value.perfect.map((entry) => ({ id: String(entry?.id || ""), name: String(entry?.name || "") }))
        : [],
      review: value.review.map((item) => ({
        sentence: String(item?.sentence || ""),
        answer: String(item?.answer || ""),
        altAnswers: Array.isArray(item?.altAnswers) ? item.altAnswers.map(String) : [],
        ja: String(item?.ja || ""),
        sentenceJa: String(item?.sentenceJa || ""),
      })),
      answers: value.answers.map((answer) => String(answer || "")),
      playerId: String(value.playerId || ""),
      isTrial: value.isTrial === true,
    };
  }

  function parse(raw, now = Date.now()) {
    let value;
    try { value = JSON.parse(raw || "null"); } catch { value = null; }
    const source = Array.isArray(value?.records) ? value.records : [];
    return source
      .map((record) => normalizeRecord(record, now))
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.resultAt) - Date.parse(left.resultAt))
      .slice(0, MAX_RECORDS);
  }

  function serialize(records, now = Date.now()) {
    return JSON.stringify({ version: 1, records: parse(JSON.stringify({ records }), now) });
  }

  function upsert(raw, record, now = Date.now()) {
    const normalized = normalizeRecord(record, now);
    if (!normalized) return { ok: false, raw: serialize(parse(raw, now), now) };
    const records = parse(raw, now).filter((item) => item.roomCode !== normalized.roomCode);
    records.unshift(normalized);
    return { ok: true, raw: serialize(records, now), record: normalized };
  }

  function find(raw, roomCode, now = Date.now()) {
    const code = String(roomCode || "").trim().toUpperCase();
    return parse(raw, now).find((record) => record.roomCode === code) || null;
  }

  return { STORAGE_KEY, RETENTION_MS, MAX_RECORDS, normalizeRecord, parse, serialize, upsert, find };
});
