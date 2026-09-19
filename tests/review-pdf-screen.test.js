const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "review-pdf.html"), "utf8");

function questions() {
  return Array.from({ length: 50 }, (_, index) => ({
    answer: index === 0 ? "managed" : `word${index + 1}`,
    altAnswers: [],
    hint: index === 0 ? "m________" : "w___",
    ja: index === 0 ? "を何とかやり遂げる、を経営する" : `意味${index + 1}`,
    sentence: index === 0 ? "I finally ___ to finish my school paper." : `The example has ___ number ${index + 1}.`,
    sentenceJa: index === 0 ? "ついに学校のレポートを書き終えることができました。" : `例文は${index + 1}番です。`,
  }));
}

async function loadPage() {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    resources: "usable",
    url: "http://localhost/review-pdf.html?room=PDF14",
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem("quizSession", JSON.stringify({
        roomCode: "PDF14",
        playerId: "host-player",
        sessionToken: "host-token",
      }));
      window.fetch = async () => ({
        ok: true,
        json: async () => ({
          setLabel: "Clacel Day 14（復習50問）",
          courseLabel: "Clacel",
          day: 14,
          dateLabel: "9月19日",
          questions: questions(),
        }),
      });
      window.print = () => {};
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(errors, []);
  return dom;
}

test("復習PDFは確定した50問を前回と同じ答案形式で表示する", async () => {
  const dom = await loadPage();
  const { document } = dom.window;
  assert.equal(document.querySelector("h1").textContent.trim(), "ÖSH Vocabulary Challenge");
  assert.equal(document.querySelector(".sub").textContent.trim(), "Clacel　9月19日（Day 14）復習問題　全50問");
  assert.equal(document.querySelectorAll(".question").length, 50);
  assert.equal(document.querySelector(".qno").textContent.trim(), "1");
  assert.equal(document.querySelector(".meaning").textContent.trim(), "を何とかやり遂げる、を経営する");
  assert.match(document.querySelector(".sentence").textContent, /_______________/);
  assert.equal(document.querySelectorAll(".answer").length, 50);
  assert.equal(document.querySelector(".answer-word").textContent.trim(), "managed");
  assert.equal(document.querySelector(".score-denominator").textContent.trim(), "/ 50");
});

test("復習PDFの問題欄には答えを表示しない", async () => {
  const dom = await loadPage();
  const firstQuestion = dom.window.document.querySelector(".question");
  assert.doesNotMatch(firstQuestion.textContent, /managed/i);
  assert.equal(firstQuestion.querySelector(".answer-word"), null);
});
