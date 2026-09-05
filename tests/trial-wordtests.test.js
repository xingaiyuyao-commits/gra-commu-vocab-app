const test = require("node:test");
const assert = require("node:assert/strict");

const WORDTESTS = require("../wordtests");

test("体験会は各コースの先頭に20問ずつ残す", () => {
  for (const [course, data] of Object.entries(WORDTESTS)) {
    const trial = data.series[0];
    assert.equal(trial.name, "体験会", course);
    assert.equal(trial.isTrial, true, course);
    assert.equal(trial.items.length, 20, course);
    assert.equal(new Set(trial.items.map(({ base }) => base)).size, 20, course);
  }
});

test("体験会の問題文・答え・例文訳は承認済みPDFから生成した通常問題と一致する", () => {
  for (const [course, data] of Object.entries(WORDTESTS)) {
    const studyItems = data.series
      .filter(({ isTrial }) => !isTrial)
      .flatMap(({ items }) => items);
    const trial = data.series[0];
    for (const item of trial.items) {
      const matches = studyItems.filter(({ base }) => base === item.base);
      assert.equal(matches.length, 1, `${course}/${item.base}: PDF内の見出し語が一意ではありません`);
      const source = matches[0];
      assert.deepEqual(
        {
          sentence: item.sentence,
          answer: item.answer,
          base: item.base,
          ja: item.ja,
          sentenceJa: item.sentenceJa,
        },
        {
          sentence: source.sentence,
          answer: source.answer,
          base: source.base,
          ja: source.ja,
          sentenceJa: source.sentenceJa,
        },
        `${course}/${item.base}: 体験会がPDF由来の問題と一致しません`,
      );
    }
  }
});

test("実行時教材は承認済み9月JSONだけを使う", () => {
  for (const data of Object.values(WORDTESTS)) {
    assert.equal(data.series.some(({ name }) => name === "Day 26"), false);
    assert.equal(data.series.some(({ name }) => name === "Day 30"), false);
  }
  assert.equal(WORDTESTS.clacel.series.find(({ name }) => name === "Day 25").items.length, 10);
  assert.match(WORDTESTS.clacel.datasetRevision, /^2026-09-04-/);
});
