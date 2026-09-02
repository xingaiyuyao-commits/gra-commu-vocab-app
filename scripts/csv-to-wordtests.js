// 編集済みCSVを wordtests-*.js に書き戻す。使い方: node scripts/csv-to-wordtests.js wordtests-clacel.csv wordtests-clacel.js "Clacel 2.0"
// hint は base/answer から自動生成するため列には含めない（手動編集による不整合を防ぐ）
const fs = require("fs");
const path = require("path");

const inFile = process.argv[2];
const outFile = process.argv[3];
const label = process.argv[4];
if (!inFile || !outFile || !label) {
  console.error('使い方: node scripts/csv-to-wordtests.js <入力.csv> <出力.js> "<label>"');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length && r.some((v) => v !== ""));
}

const outPath = path.resolve(__dirname, "..", outFile);
const csvPath = path.resolve(__dirname, "..", inFile);
const text = fs.readFileSync(csvPath, "utf8");
const rows = parseCsv(text);
const header = rows.shift();
const col = (name) => header.indexOf(name);
const iSeries = col("series"),
  iPhase = col("phase"),
  iOrder = col("order"),
  iSentence = col("sentence"),
  iAnswer = col("answer"),
  iBase = col("base"),
  iJa = col("ja");
if ([iSeries, iPhase, iOrder, iSentence, iAnswer, iBase, iJa].some((i) => i === -1)) {
  console.error("CSVのヘッダーに series,phase,order,sentence,answer,base,ja が揃っていません");
  process.exit(1);
}

function makeHint(base, answer) {
  return answer[0] + "_".repeat(answer.length - 1);
}

const seriesMap = new Map();
rows.forEach((r) => {
  const name = r[iSeries];
  if (!seriesMap.has(name)) seriesMap.set(name, { phase: Number(r[iPhase]) || 1, items: [] });
  const answer = r[iAnswer].trim().toLowerCase();
  const base = r[iBase].trim().toLowerCase();
  seriesMap.get(name).items.push({
    order: Number(r[iOrder]) || 0,
    sentence: r[iSentence].trim(),
    answer,
    base,
    hint: makeHint(base, answer),
    ja: r[iJa].trim(),
  });
});

const series = Array.from(seriesMap.entries()).map(([name, { phase, items }]) => ({
  name,
  phase,
  items: items.sort((a, b) => a.order - b.order).map(({ order, ...it }) => it),
}));

// 既存ファイルの先頭コメント（// で始まる行）があれば引き継ぐ
let headerComment = "";
if (fs.existsSync(outPath)) {
  const existing = fs.readFileSync(outPath, "utf8");
  const lines = existing.split("\n");
  const commentLines = [];
  for (const line of lines) {
    if (line.startsWith("//")) commentLines.push(line);
    else break;
  }
  if (commentLines.length) headerComment = commentLines.join("\n") + "\n";
}

function jsStringLiteral(s) {
  return JSON.stringify(s);
}

let out = headerComment;
out += "module.exports = {\n";
out += `  label: ${jsStringLiteral(label)},\n`;
out += "  series: [\n";
series.forEach((s) => {
  out += "    {\n";
  out += `      name: ${jsStringLiteral(s.name)},\n`;
  out += `      phase: ${s.phase},\n`;
  out += "      items: [\n";
  s.items.forEach((it) => {
    out += `        { sentence: ${jsStringLiteral(it.sentence)}, answer: ${jsStringLiteral(it.answer)}, base: ${jsStringLiteral(it.base)}, hint: ${jsStringLiteral(it.hint)}, ja: ${jsStringLiteral(it.ja)} },\n`;
  });
  out += "      ],\n";
  out += "    },\n";
});
out += "  ],\n";
out += "};\n";

fs.writeFileSync(outPath, out, "utf8");
console.log(`書き戻し完了: ${outFile}（${series.length} series / ${series.reduce((n, s) => n + s.items.length, 0)}問）`);
