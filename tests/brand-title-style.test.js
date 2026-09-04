const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const read = (name) => fs.readFileSync(path.join(publicDir, name), "utf8");

const brandTitleStyle = [
  /font-family:\s*Arial,\s*"Helvetica Neue",\s*"Hiragino Sans",\s*"Yu Gothic UI",\s*"Yu Gothic",\s*sans-serif/,
  /font-weight:\s*800/,
  /letter-spacing:\s*[-−]\.075em/,
  /line-height:\s*\.92/,
];

test("ブランドタイトルは全画面でホームと同じ書体・太さ・字間・行間を使う", () => {
  const selectors = {
    "index.html": "h1",
    "quiz.html": ".site-title",
    "results-history.html": ".site-title",
  };

  for (const [file, selector] of Object.entries(selectors)) {
    const html = read(file);
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
    for (const pattern of brandTitleStyle) {
      assert.match(block, pattern, `${file} の ${selector} にブランド書体を適用する`);
    }
  }
});

test("入室後の小さいタイトルもブランドの字間を上書きしない", () => {
  const html = read("quiz.html");
  const block = html.match(/\.container\.in-room \.site-title\s*\{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(block, /letter-spacing/);
});

test("PCホームは内部間隔を変えずページ全体を上寄せする", () => {
  const html = read("index.html");
  assert.match(
    html,
    /@media\s*\(min-width:\s*901px\)\s*\{\s*\.page\s*\{[^}]*padding-bottom:\s*clamp\(96px,\s*10vh,\s*140px\)/,
  );
  assert.match(
    html,
    /\.page:has\(\.today-card:not\(\[hidden\]\)\)\s*\{[^}]*padding-bottom:\s*20px/,
  );
  assert.match(html, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.page\s*\{[^}]*padding:\s*28px 16px 56px/);
});
