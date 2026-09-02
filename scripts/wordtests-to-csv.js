// wordtests-*.js を編集用CSVに書き出す。使い方: node scripts/wordtests-to-csv.js wordtests-clacel.js wordtests-clacel.csv
const fs = require("fs");
const path = require("path");

const inFile = process.argv[2];
const outFile = process.argv[3];
if (!inFile || !outFile) {
  console.error("使い方: node scripts/wordtests-to-csv.js <入力.js> <出力.csv>");
  process.exit(1);
}

const data = require(path.resolve(__dirname, "..", inFile));

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = [["series", "phase", "order", "sentence", "answer", "base", "ja"]];
data.series.forEach((s) => {
  s.items.forEach((it, i) => {
    rows.push([s.name, s.phase ?? 1, i + 1, it.sentence, it.answer, it.base, it.ja]);
  });
});

const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
fs.writeFileSync(path.resolve(__dirname, "..", outFile), csv, "utf8");
console.log(`書き出し完了: ${outFile}（${rows.length - 1}行）`);
