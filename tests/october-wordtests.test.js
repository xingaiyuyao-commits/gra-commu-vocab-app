const test = require("node:test");
const assert = require("node:assert/strict");

const wordtests = require("../wordtests");
const { getHomeStudyDay } = require("../public/ui-logic");

const EXPECTED_BASES = {
  clacel: {
    26: ["figure out", "no longer", "so far", "get used to", "as long as", "end up doing", "by accident", "look forward to", "come across", "look after", "pretend", "remove", "stand", "concern", "recognize", "dig", "spread", "disturb", "handle", "waste"],
    27: ["feel like doing", "go with", "be supposed to", "bring up", "take for granted", "tend to do", "catch up with", "for sure", "get along with", "in reality", "few", "engaged", "curious", "basically", "still", "sick of", "none of one's business", "come to", "end up", "due to"],
  },
  toeic: {
    26: ["goods", "equity", "dividend", "sponsorship", "transaction", "hedge", "premium", "impact", "maturity", "economist", "media", "variance", "depreciation", "recession", "overhead", "euro", "valuation", "coupon", "subsidiary", "volatility"],
    27: ["economically", "exclusively", "officially", "poorly", "loudly", "traditionally", "comfortably", "electronically", "anyhow", "unusually", "fortunately", "environmentally", "enthusiastically", "permanently", "partially", "drastically", "actively", "intently", "hereby", "automatically"],
  },
  ielts: {
    26: ["artistic", "dense", "differential", "elastic", "elite", "evolutionary", "fluid", "implicit", "incredible", "indirect", "informal", "innate", "integral", "intermediate", "neutral", "numerical", "optimal", "oral", "philosophical", "pragmatic"],
    27: ["nonetheless", "whereby", "afterward", "internationally", "genetically", "likewise", "moreover", "furthermore", "nevertheless", "hence", "thus", "meanwhile", "henceforth", "overall", "roughly", "virtually", "seemingly", "invariably", "successively", "progressively"],
  },
};

test("10月1日と2日は正本どおりのDay 26・27を3コースで配信する", () => {
  assert.equal(getHomeStudyDay(new Date("2026-10-01T12:00:00+09:00")), 26);
  assert.equal(getHomeStudyDay(new Date("2026-10-02T12:00:00+09:00")), 27);
  for (const [course, days] of Object.entries(EXPECTED_BASES)) {
    for (const [day, expectedBases] of Object.entries(days)) {
      const series = wordtests[course].series.find((entry) => entry.day === Number(day));
      assert.ok(series, `${course}: Day ${day}`);
      assert.deepEqual(series.items.map(({ base }) => base), expectedBases, `${course}: Day ${day}`);
      assert.equal(series.items.length, 20, `${course}: Day ${day}`);
      for (const item of series.items) {
        assert.match(item.questionId, new RegExp(`^2026-10/${course}/day${day}/q\\d{2}$`));
        assert.ok(item.sentence.includes("___"), `${item.questionId}: 空欄なし`);
        assert.ok(item.answer && item.hint && item.ja && item.sentenceJa, `${item.questionId}: 必須項目不足`);
      }
    }
  }
});
