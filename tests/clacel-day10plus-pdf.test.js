const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const clacel = require("../wordtests-clacel");

// Clacel_9月範囲_日本語訳付き.pdf の Day 10〜25（復習日を除く）を正本にした値。
// 問題文・解答・単語・意味・例文訳・ヒントの全フィールドを日別に検証する。
const PDF_DAYS = {
  10: { count: 20, sha256: "431816b2069e6e98bf7bfae45bd611f7f38ade167041be32fd4239fcd2317186" },
  11: { count: 20, sha256: "bf4f6e5c7ac0170d6588c06855fc58832f45bf2861561931bf539e1bc6097209" },
  12: { count: 20, sha256: "0a424053896c113a36e441400e88a6a340c8bd529a3ebebfe023c45e19539453" },
  13: { count: 20, sha256: "dd1b134911ac6bc6e1580252dc718a42b979abad7a65be0d2ce99ad3e9e1fd0f" },
  15: { count: 20, sha256: "74aa468c86c64939ce95ffe479b345396cfeaf6dae68629bcc67c6d8d8f11e91" },
  16: { count: 20, sha256: "1523f60982acaab4648fd6c233ed0b72ce2ff1720353ff0829f46889c182d0e9" },
  17: { count: 20, sha256: "2eecef0f323aea9141393c94f3e94e1f94f68737a3a5ff8982c7a5700c06561f" },
  18: { count: 19, sha256: "c33796b3d45e3a831b4a4ab1838e418616bc2182200a567da15f078aeb57f21e" },
  19: { count: 20, sha256: "a1c97e3e8cb97c79e9ef9e76c550c1a6aba7b0b38df9f3d77d350c75e540ba2c" },
  20: { count: 20, sha256: "319955e09dfdfe63f01ca5a6d4804100260a5a82f7aa0fc00a1c5cfe49664a73" },
  22: { count: 20, sha256: "ac01945e1cf2c0de462a9a4acf4226b87b33b42490acee16aa6fee65410240d9" },
  23: { count: 20, sha256: "b494fe64284e825ac844493abbaf7220f73b58ca7da7be877df82625801087b6" },
  24: { count: 20, sha256: "da31bb25a41461bd9ef88bd18d4d08580c183b799cdfbd9cc7699de1db7e2d69" },
  25: { count: 10, sha256: "9030c82d449952b1fc25dfc485b907a72104bc48c31506e7038584235f0bdfb2" },
};

function digest(items) {
  const fields = items.map(({ base, sentence, answer, ja, sentenceJa, hint }) => ({
    base,
    sentence,
    answer,
    ja,
    sentenceJa,
    hint,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

for (const [day, expected] of Object.entries(PDF_DAYS)) {
  test(`Clacel Day ${day}が9月PDFと全項目一致する`, () => {
    const series = clacel.series.find((entry) => entry.name === `Day ${day}`);
    assert.ok(series, `Clacel Day ${day}がありません`);
    assert.equal(series.items.length, expected.count);
    assert.equal(digest(series.items), expected.sha256);
  });
}
