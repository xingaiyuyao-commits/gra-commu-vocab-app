// wordtests-*.js の構造検査。使い方: node scripts/validate-wordtests.js wordtests-clacel.js 20,20,20,20,20,20,20,12
// 第2引数はシリーズごとの期待語数（カンマ区切り）
const path = require("path");
const file = process.argv[2];
const expectedCounts = (process.argv[3] || "").split(",").map(Number);
const data = require(path.resolve(__dirname, "..", file));

const errors = [];
if (!data.label) errors.push("label がありません");
if (!Array.isArray(data.series) || data.series.length !== expectedCounts.length)
  errors.push(`series 数が ${expectedCounts.length} ではありません: ${data.series ? data.series.length : 0}`);

(data.series || []).forEach((s, si) => {
  if (!s.name) errors.push(`series[${si}]: name がありません`);
  if (!Array.isArray(s.items) || s.items.length !== expectedCounts[si])
    errors.push(`${s.name}: items が${expectedCounts[si]}件ではありません (${s.items ? s.items.length : 0})`);
  const seen = new Set();
  (s.items || []).forEach((it, i) => {
    const tag = `${s.name} #${i + 1}`;
    if (!it.sentence || !it.sentence.includes("___")) errors.push(`${tag}: sentence に ___ がありません`);
    if (!it.answer || it.answer !== it.answer.toLowerCase()) errors.push(`${tag}: answer が小文字ではありません`);
    // イディオム・句動詞は複数語（単語間は半角スペース1つ）のためスペースを許容する
    if (!/^[a-z][a-z'-]*( [a-z][a-z'-]*)*$/.test(it.answer || "")) errors.push(`${tag}: answer の形式が不正: ${it.answer}`);
    if (!it.base || it.base !== it.base.toLowerCase()) errors.push(`${tag}: base が小文字ではありません`);
    // hintは実際のゲーム内ではサーバー側quizHint(base)がその場で計算し直すため、
    // ここではhintがbase（見出し語）の文字数・先頭文字と対応しているかを検査する
    if (!it.hint || it.hint.length !== it.base.length || it.hint[0] !== it.base[0])
      errors.push(`${tag}: hint が base（見出し語）と対応していません`);
    if (!it.ja) errors.push(`${tag}: ja がありません`);
    if (seen.has(it.base)) errors.push(`${s.name}: base 重複 ${it.base}`);
    seen.add(it.base);
  });
});

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const total = data.series.reduce((sum, s) => sum + s.items.length, 0);
console.log(`OK: ${file}（${data.series.length} series / ${total}問）`);
