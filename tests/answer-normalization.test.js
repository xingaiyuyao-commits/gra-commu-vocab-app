const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { normalizeAnswer, calculateResult, getSubmissionSummary } = require("../public/ui-logic");
const wordtests = require("../wordtests");

const SPACE_VARIANTS = [" ", "   ", "\u3000", "\u00a0", "\u202f", "\u2003", "\t", "\r\n", " \u3000\u00a0\t "];

test("回答の大文字・前後空白・連続したUnicode空白を共通の半角スペースへ正規化する", () => {
  for (const space of SPACE_VARIANTS) {
    assert.equal(normalizeAnswer(`${space}COME${space}UP${space}WITH${space}`), "come up with");
  }
  assert.equal(normalizeAnswer(null), "");
  assert.equal(normalizeAnswer(undefined), "");
  assert.equal(normalizeAnswer("\u3000\u00a0\t\n"), "");
  assert.deepEqual(getSubmissionSummary(["\u3000\u00a0", "COME\u3000UP", "\t\n"]), {
    answered: 1,
    unanswered: 2,
    unansweredNumbers: [1, 3],
    total: 3,
  });
});

test("ブラウザとサーバーから同じ回答正規化ヘルパーを使用できる", () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/ui-logic.js"), "utf8"), browser);
  assert.equal(typeof browser.QuizUi.normalizeAnswer, "function");
  for (const space of SPACE_VARIANTS) {
    const answer = `${space}IN${space}PERSON${space}`;
    assert.equal(browser.QuizUi.normalizeAnswer(answer), normalizeAnswer(answer));
  }
});

for (const course of ["clacel", "toeic", "ielts"]) {
  const questions = wordtests[course].series.flatMap(({ items }) => items);

  test(`${course}: 全問題の正解は空白種別・大文字だけが違っても正解になる`, () => {
    assert.ok(questions.length > 0);
    const originalKeys = JSON.stringify(questions);
    for (const space of SPACE_VARIANTS) {
      const answers = questions.map(({ answer }) => `${space}${answer.toUpperCase().replace(/\s+/g, space)}${space}`);
      assert.deepEqual(calculateResult(answers, questions), {
        score: questions.length,
        total: questions.length,
        accuracy: 100,
      }, `${course}: ${JSON.stringify(space)}`);
    }
    assert.equal(JSON.stringify(questions), originalKeys, "正解キーと別解は変更しない");
  });

  test(`${course}: 別の単語・許容されていない原形・追加の句読点は不正解のまま`, () => {
    const inflected = questions.find((question) => question.answer !== question.base
      && question.base
      && !(question.altAnswers || []).includes(question.base));
    assert.ok(inflected, `${course}: 活用形の検証対象が存在する`);
    for (const wrong of ["not the correct word", inflected.base, `${inflected.answer}.`]) {
      assert.deepEqual(calculateResult([`\u3000${wrong.toUpperCase()}\u00a0`], [inflected]), {
        score: 0,
        total: 1,
        accuracy: 0,
      }, `${course}: ${wrong}`);
    }
  });
}

test("複数語の正解は空白の削除・単語の置換・ハイフンへの置換を許容しない", () => {
  for (const course of ["clacel", "toeic"]) {
    const question = wordtests[course].series.flatMap(({ items }) => items)
      .find(({ answer }) => answer.includes(" "));
    assert.ok(question, `${course}: 複数語の検証対象が存在する`);
    const words = question.answer.split(" ");
    const wrongAnswers = [words.join(""), words.join("-"), ["wrong", ...words.slice(1)].join(" ")];
    for (const answer of wrongAnswers) {
      assert.equal(calculateResult([answer], [question]).score, 0, `${course}: ${answer}`);
    }
  }
  assert.equal(calculateResult(["c o v e r s"], [{ answer: "covers" }]).score, 0);
  assert.equal(calculateResult(["ｃｏｖｅｒｓ"], [{ answer: "covers" }]).score, 0);
  assert.equal(calculateResult(["can’t"], [{ answer: "can't" }]).score, 0);
});

test("明示された別解も同じ空白正規化で照合し、新しい別解や活用形を追加しない", () => {
  const question = { answer: "checked out", altAnswers: ["looked over"] };
  const original = JSON.stringify(question);
  assert.equal(calculateResult(["\u3000CHECKED\u3000\u00a0OUT "], [question]).score, 1);
  assert.equal(calculateResult([" LOOKED\u00a0\u00a0OVER\u3000"], [question]).score, 1);
  for (const wrong of ["check out", "look over", "checked in", "inspected"]) {
    assert.equal(calculateResult([wrong], [question]).score, 0, wrong);
  }
  assert.equal(JSON.stringify(question), original);
  assert.equal(calculateResult(["looked over"], [{ answer: "checked out", altAnswers: [" LOOKED\u3000OVER "] }]).score, 1);
});
