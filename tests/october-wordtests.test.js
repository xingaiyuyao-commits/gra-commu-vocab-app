const test = require("node:test");
const assert = require("node:assert/strict");

const wordtests = require("../wordtests");
const { getHomeStudyDay } = require("../public/ui-logic");

const EXPECTED_BASES = {
  clacel: {
    26: ["figure out", "no longer", "so far", "get used to", "as long as", "end up doing", "by accident", "look forward to", "come across", "look after", "pretend", "remove", "stand", "concern", "recognize", "dig", "spread", "disturb", "handle", "waste"],
    27: ["feel like doing", "go with", "be supposed to", "bring up", "take for granted", "tend to do", "catch up with", "for sure", "get along with", "in reality", "few", "engaged", "curious", "basically", "still", "sick of", "none of one's business", "come to", "end up", "due to"],
    29: ["feel like", "by mistake", "run out of", "tend to", "in spite of", "in vain", "go through", "familiar with", "willing to", "provided that", "show off", "sooner or later", "keep up with", "off to", "turn in", "put in", "take in", "cut in", "break in", "put on"],
    30: ["get on", "rely on", "work on", "move on", "look at", "arrive at", "listen to", "talk to", "give to", "recover from", "fall in love with", "deal with", "look for", "wait for", "ask for", "pay for", "drop by", "stand by", "pass by", "take out"],
    31: ["come out", "turn out", "check out", "go out", "find out", "wake up", "pick up", "grow up", "show up", "heat up", "break up", "catch up", "give up", "when it comes to", "come in handy", "be familiar with", "be willing to", "hold back", "get rid of", "stick"],
    32: ["travel", "lock", "confuse", "contain", "stretch", "award", "guard", "trap", "plant", "organize", "invent", "wonder", "trade", "grow", "bite", "mind", "promise", "fix", "happen", "feed"],
    33: ["hunt", "connect", "compete", "blow", "reach", "retire", "create", "serve", "switch", "vote", "wake", "continue", "delay", "park", "complete", "depend", "accept", "fail", "ignore", "request"],
    34: ["search", "hurt", "spill", "imagine", "reply", "encourage", "deliver", "survive", "rent", "decide", "warn", "reserve", "turn", "rise", "attend", "escape", "throw", "lay", "guide", "notice"],
  },
  toeic: {
    26: ["goods", "equity", "dividend", "sponsorship", "transaction", "hedge", "premium", "impact", "maturity", "economist", "media", "variance", "depreciation", "recession", "overhead", "euro", "valuation", "coupon", "subsidiary", "volatility"],
    27: ["economically", "exclusively", "officially", "poorly", "loudly", "traditionally", "comfortably", "electronically", "anyhow", "unusually", "fortunately", "environmentally", "enthusiastically", "permanently", "partially", "drastically", "actively", "intently", "hereby", "automatically"],
    29: ["acknowledge", "announce", "appoint", "assign", "award", "boost", "brief", "register", "charge", "chair", "collaborate", "combine", "commence", "commission", "consult", "convene", "cut", "withdraw", "decline", "dedicate"],
    30: ["deliver", "deploy", "detect", "diversify", "earn", "endorse", "engage", "enlist", "escalate", "exceed", "extend", "file", "forecast", "retain", "grant", "hire", "implement", "launch", "sponsor", "sign"],
    31: ["portfolio", "distribution", "authority", "sometime", "marginal", "entity", "productivity", "organizational", "commodity", "monetary", "aggregate", "fiscal", "payable", "default", "aspect", "calculation", "allocation", "deviation", "receivable", "equilibrium"],
    32: ["creditor", "derivative", "surplus", "annuity", "disclosure", "regime", "leverage", "internet", "parliament", "coalition", "lender", "liquidity", "stockholder", "fraud", "regulator", "swap", "bankruptcy", "provider", "regression", "turnover"],
    33: ["incur", "risky", "gross", "constitution", "trader", "monopoly", "correlation", "stockmarket", "breach", "subsidy", "auditor", "banker", "corruption", "issuer", "borrower", "insurer", "profitability", "debit", "duration", "scenario"],
    34: ["terrorism", "respondent", "regulatory", "takeover", "coefficient", "optimal", "nominal", "infrastructure", "disclose", "offset", "effectiveness", "merchandise", "bound", "bargain", "conversion", "statistics", "stakeholder", "administrative", "taxpayer", "alliance"],
  },
  ielts: {
    26: ["artistic", "dense", "differential", "elastic", "elite", "evolutionary", "fluid", "implicit", "incredible", "indirect", "informal", "innate", "integral", "intermediate", "neutral", "numerical", "optimal", "oral", "philosophical", "pragmatic"],
    27: ["nonetheless", "whereby", "afterward", "internationally", "genetically", "likewise", "moreover", "furthermore", "nevertheless", "hence", "thus", "meanwhile", "henceforth", "overall", "roughly", "virtually", "seemingly", "invariably", "successively", "progressively"],
    29: ["postulate", "stipulate", "substantiate", "corroborate", "extrapolate", "synthesize", "formalize", "codify", "delineate", "enumerate", "exemplify", "annotate", "transcend", "underpin", "disseminate", "perpetuate", "proliferate", "reconcile", "refute", "reiterate"],
    30: ["stem", "permeate", "instigate", "legitimize", "optimize", "cohere", "complicate", "curtail", "underlie", "encapsulate", "mitigate", "alleviate", "exacerbate", "counteract", "rectify", "consolidate", "streamline", "juxtapose", "calibrate", "paraphrase"],
    31: ["impact", "domain", "semantic", "damp", "secrete", "matrix", "linear", "graph", "linguistic", "acid", "velocity", "interval", "discourse", "stimulus", "vector", "electron", "receptor", "theorem", "developmental", "bound"],
    32: ["molecular", "transformation", "spatial", "coefficient", "translation", "membrane", "neuron", "simulation", "lexical", "variance", "molecule", "marker", "robot", "statistical", "vowel", "intensity", "regression", "diagnosis", "identification", "node"],
    33: ["partial", "temporal", "particle", "duration", "consumption", "mutation", "phonological", "spectrum", "nucleus", "integration", "pathway", "subset", "syntactic", "orientation", "inequality", "prevalence", "pulse", "trait", "prediction", "syllable"],
    34: ["chromosome", "magnetic", "transmission", "dose", "maternal", "axis", "rational", "locus", "approximation", "thesis", "sin", "threshold", "syndrome", "activate", "adolescent", "vocabulary", "utterance", "induction", "trajectory", "grammatical"],
  },
};

test("10月1日・2日と10月4日〜9日は正本どおりのDay 26・27・29〜34を3コースで配信する", () => {
  assert.equal(getHomeStudyDay(new Date("2026-10-01T12:00:00+09:00")), 26);
  assert.equal(getHomeStudyDay(new Date("2026-10-02T12:00:00+09:00")), 27);
  for (const [date, day] of [["04", 29], ["05", 30], ["06", 31], ["07", 32], ["08", 33], ["09", 34]]) {
    assert.equal(getHomeStudyDay(new Date(`2026-10-${date}T12:00:00+09:00`)), day);
  }
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
        assert.equal(item.hint[0].toLowerCase(), item.answer[0].toLowerCase(), `${item.questionId}: 頭文字ヒント`);
      }
    }
  }
});

test("TOEIC・IELTS Day 26・27は確定PDFの問題文・意味・和訳を配信する", () => {
  const findItem = (course, day, base) => {
    const series = wordtests[course].series.find((entry) => entry.day === day);
    return series.items.find((item) => item.base === base);
  };

  assert.deepEqual(findItem("toeic", 26, "transaction"), {
    questionId: "2026-10/toeic/day26/q05",
    sentence: "We need to monitor all ___, including smaller deals.",
    answer: "transactions",
    base: "transaction",
    hint: "t__________",
    ja: "取引",
    sentenceJa: "小規模なものも含め、すべての取引を監視する必要がある。",
  });
  assert.equal(findItem("toeic", 26, "overhead").sentence, "Rent and utilities are part of our ___.");
  assert.equal(findItem("toeic", 26, "economist").sentence, "Mr. Toledo is a former World Bank ___.");
  assert.equal(findItem("toeic", 27, "traditionally").sentence, "___, the company's main markets have been Britain and the US.");
  assert.equal(findItem("toeic", 27, "electronically").sentence, "The information is stored ___.");
  assert.equal(findItem("toeic", 27, "drastically").ja, "大幅に、劇的に");

  assert.equal(findItem("ielts", 26, "differential").sentence, "The policy had ___ effects on different age groups.");
  assert.equal(findItem("ielts", 26, "evolutionary").ja, "進化の、漸進的な");
  assert.equal(findItem("ielts", 26, "integral").sentence, "Trust is an ___ part of a strong relationship.");
  assert.equal(findItem("ielts", 26, "oral").sentence, "The course includes an ___ examination.");
  assert.equal(findItem("ielts", 27, "meanwhile").sentence, "My sister bought a car. ___, I'm renting one.");
  assert.equal(findItem("ielts", 27, "meanwhile").sentenceJa, "姉は車を買いました。一方、私は車を借りています。");
  assert.equal(findItem("ielts", 27, "overall").sentence, "___, the situation is good despite a few minor problems.");
});

test("頭文字ヒントは見出し語ではなく実際に入力する正解から作る", () => {
  const day27 = wordtests.clacel.series.find((entry) => entry.day === 27);
  const supposedTo = day27.items.find((item) => item.base === "be supposed to");

  assert.equal(supposedTo.answer, "supposed to");
  assert.equal(supposedTo.hint[0], "s");
  assert.equal(supposedTo.hint.length, supposedTo.base.length);
});
