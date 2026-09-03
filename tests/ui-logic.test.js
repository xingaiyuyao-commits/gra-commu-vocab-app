const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getStudyDay,
  getProjectWeek,
  countWeeklyMistakes,
  readWeeklyMistakes,
  writeWeeklyMistakeRecord,
  canCreateRoom,
  getSubmissionSummary,
  calculateResult,
} = require("../public/ui-logic");

test("正式Day 1の開始前はDayを表示しない", () => {
  assert.equal(getStudyDay(new Date("2026-09-06T19:29:59+09:00")), null);
});

test("2026年9月6日19時30分をDay 1として毎日1ずつ進める", () => {
  assert.equal(getStudyDay(new Date("2026-09-06T19:30:00+09:00")), 1);
  assert.equal(getStudyDay(new Date("2026-09-07T19:29:59+09:00")), 1);
  assert.equal(getStudyDay(new Date("2026-09-07T19:30:00+09:00")), 2);
});

test("プロジェクト週は正式Day 1の開始時刻から7日ごとに区切る", () => {
  assert.equal(getProjectWeek(new Date("2026-09-06T19:29:59+09:00")), null);
  assert.deepEqual(getProjectWeek(new Date("2026-09-06T19:30:00+09:00")), {
    id: "2026-09-06",
    startsAt: Date.parse("2026-09-06T19:30:00+09:00"),
    endsAt: Date.parse("2026-09-13T19:30:00+09:00"),
  });
  assert.deepEqual(getProjectWeek(new Date("2026-09-13T19:30:00+09:00")), {
    id: "2026-09-13",
    startsAt: Date.parse("2026-09-13T19:30:00+09:00"),
    endsAt: Date.parse("2026-09-20T19:30:00+09:00"),
  });
});

test("週間復習は9月6日と9月13日の19時30分ちょうどに週を切り替える", () => {
  const firstWeek = JSON.stringify({
    weekId: "2026-09-06",
    records: [{ at: "2026-09-13T10:29:59.000Z", category: "clacel", setLabel: "Day 7", words: [
      { answer: "keep", altAnswers: [], ja: "保つ", sentence: "I ___ it.", sentenceJa: "私はそれを保つ。" },
    ] }],
  });

  assert.deepEqual(readWeeklyMistakes(firstWeek, new Date("2026-09-06T19:29:59+09:00")), {
    weekId: null,
    records: [],
  });
  assert.equal(
    readWeeklyMistakes(firstWeek, new Date("2026-09-06T19:30:00+09:00")).records.length,
    1,
  );
  assert.equal(
    readWeeklyMistakes(firstWeek, new Date("2026-09-13T19:29:59+09:00")).records.length,
    1,
  );
  assert.deepEqual(readWeeklyMistakes(firstWeek, new Date("2026-09-13T19:30:00+09:00")), {
    weekId: "2026-09-13",
    records: [],
  });
});

test("週間復習は壊れた保存データを空として扱う", () => {
  const now = new Date("2026-09-07T19:30:00+09:00");
  assert.deepEqual(readWeeklyMistakes("{broken", now), { weekId: "2026-09-06", records: [] });
  assert.deepEqual(readWeeklyMistakes(JSON.stringify({ weekId: "2026-09-06", records: "bad" }), now), {
    weekId: "2026-09-06",
    records: [],
  });
});

test("週間復習の件数専用ヘルパーは現在週の語数だけを数える", () => {
  const now = new Date("2026-09-08T19:30:00+09:00");
  const raw = JSON.stringify({
    weekId: "2026-09-06",
    records: [
      { at: "2026-09-07T10:30:00.000Z", category: "clacel", setLabel: "Day 2", words: [
        { answer: "drink", altAnswers: [], ja: "飲む", sentence: "I ___ tea.", sentenceJa: "私はお茶を飲む。" },
      ] },
      { at: "2026-09-08T10:30:00.000Z", category: "toeic", setLabel: "Day 3", words: [
        { answer: "read", altAnswers: [], ja: "読む", sentence: "I ___ books.", sentenceJa: "私は本を読む。" },
        { answer: "write", altAnswers: [], ja: "書く", sentence: "I ___ notes.", sentenceJa: "私はメモを書く。" },
      ] },
    ],
  });

  assert.equal(countWeeklyMistakes(raw, now), 3);
  assert.equal(countWeeklyMistakes(raw, new Date("2026-09-13T19:30:00+09:00")), 0);
});

test("週間復習は不正な記録または単語を文書ごと拒否し、件数も0にする", () => {
  const now = new Date("2026-09-08T19:30:00+09:00");
  const validWord = {
    answer: "drink", altAnswers: [], ja: "飲む", sentence: "I ___ tea.", sentenceJa: "私はお茶を飲む。",
  };
  const validRecord = {
    at: "2026-09-07T10:30:00.000Z", category: "clacel", setLabel: "Day 2", words: [validWord],
  };
  const malformedRecords = [
    { ...validRecord, at: "not-an-iso-date" },
    { ...validRecord, at: "2026-02-31T10:30:00.000Z" },
    { ...validRecord, category: "" },
    { ...validRecord, category: "unknown" },
    { ...validRecord, setLabel: "  " },
    { ...validRecord, words: "not-an-array" },
  ];
  const malformedWords = [
    { ...validWord, answer: "" },
    { ...validWord, ja: 123 },
    { ...validWord, sentence: " " },
    { answer: "drink", altAnswers: [], ja: "飲む", sentence: "I ___ tea." },
    { ...validWord, altAnswers: ["drank", 123] },
  ];
  const documents = [
    ...malformedRecords.map((record) => ({ weekId: "2026-09-06", records: [record] })),
    ...malformedWords.map((word) => ({ weekId: "2026-09-06", records: [{ ...validRecord, words: [word] }] })),
  ];

  for (const document of documents) {
    const raw = JSON.stringify(document);
    assert.deepEqual(readWeeklyMistakes(raw, now), { weekId: "2026-09-06", records: [] });
    assert.equal(countWeeklyMistakes(raw, now), 0);
  }
});

test("週間復習は同じ週の同一コース・問題セットを最新内容へ置換する", () => {
  const now = new Date("2026-09-08T19:30:00+09:00");
  const first = writeWeeklyMistakeRecord(null, {
    at: "2026-09-07T10:30:00.000Z",
    category: "clacel",
    setLabel: "Day 2",
    words: [{ answer: "old", altAnswers: [], ja: "旧", sentence: "I ___ it.", sentenceJa: "私はそれをする。" }],
  }, now);
  const replaced = writeWeeklyMistakeRecord(JSON.stringify(first), {
    at: "2026-09-08T10:30:00.000Z",
    category: "clacel",
    setLabel: "Day 2",
    words: [{ answer: "new", altAnswers: [], ja: "新", sentence: "I ___ this.", sentenceJa: "私はこれをする。" }],
  }, now);

  assert.equal(replaced.records.length, 1);
  assert.equal(replaced.records[0].at, "2026-09-08T10:30:00.000Z");
  assert.equal(replaced.records[0].words[0].answer, "new");
});

test("週間復習は端末あたり最新420語までを日付順・出題順で保持する", () => {
  const now = new Date("2026-09-12T19:30:00+09:00");
  const existing = {
    weekId: "2026-09-06",
    records: [{
      at: "2026-09-07T10:30:00.000Z",
      category: "clacel",
      setLabel: "Day 1",
      words: Array.from({ length: 419 }, (_, index) => ({
        answer: `old-${index + 1}`,
        altAnswers: [],
        ja: `意味${index + 1}`,
        sentence: `Old ${index + 1}: ___`,
        sentenceJa: `古い例文${index + 1}`,
      })),
    }],
  };
  const next = writeWeeklyMistakeRecord(JSON.stringify(existing), {
    at: "2026-09-12T10:30:00.000Z",
    category: "toeic",
    setLabel: "Day 6",
    words: [
      { answer: "new-1", altAnswers: ["new-one"], ja: "新1", sentence: "New 1: ___", sentenceJa: "新しい例文1", mine: "raw" },
      { answer: "new-2", altAnswers: [], ja: "新2", sentence: "New 2: ___", sentenceJa: "新しい例文2", name: "person" },
    ],
    roomCode: "SECRET",
  }, now);
  const words = next.records.flatMap((record) => record.words);

  assert.equal(words.length, 420);
  assert.equal(words[0].answer, "old-2", "上限超過時は最古の語から落とす");
  assert.deepEqual(words.at(-1), {
    answer: "new-2",
    altAnswers: [],
    ja: "新2",
    sentence: "New 2: ___",
    sentenceJa: "新しい例文2",
  });
  assert.deepEqual(Object.keys(next.records.at(-1)), ["at", "category", "setLabel", "words"]);
});

test("名前と単語帳の両方が揃った場合だけルームを作成できる", () => {
  assert.equal(canCreateRoom("", "clacel"), false);
  assert.equal(canCreateRoom("  ", "clacel"), false);
  assert.equal(canCreateRoom("Tina", null), false);
  assert.equal(canCreateRoom("Tina", "clacel"), true);
});

test("提出前に回答済み数・未回答数・未回答の問題番号を返す", () => {
  assert.deepEqual(getSubmissionSummary(["answer", " ", "word", ""]), {
    answered: 2,
    unanswered: 2,
    unansweredNumbers: [2, 4],
    total: 4,
  });
});

test("別解と大文字・前後空白を考慮して本人の点数と正答率を計算する", () => {
  const result = calculateResult(
    [" RUNS ", "learnt", "wrong", ""],
    [
      { answer: "runs" },
      { answer: "learned", altAnswers: ["learnt"] },
      { answer: "right" },
      { answer: "final" },
    ],
  );
  assert.deepEqual(result, { score: 2, total: 4, accuracy: 50 });
});
