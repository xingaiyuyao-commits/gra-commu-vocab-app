# September Content and Review Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production vocabulary sets with the three approved September PDFs, remove browser-based word editing, and add persistent, mistake-prioritized 50-question review days for each course.

**Architecture:** Convert the approved PDFs offline into versioned JSON datasets and load those datasets at runtime. Persist full per-question daily aggregates in the existing `/data` state, derive review selections from the preceding six study days, and persist the selected questions in each room so reconnects and restarts cannot reshuffle them.

**Tech Stack:** Node.js, Express, Socket.IO, JSON, Node test runner, JSDOM, Python/pdfplumber for offline PDF import, Railway persistent volume.

**Spec:** `docs/superpowers/specs/2026-09-04-september-content-and-review-day-design.md`

## Global Constraints

- The approved source PDFs are `/Users/tina/Desktop/Clacel_9月範囲.pdf`, `/Users/tina/Desktop/TOEIC_9月範囲.pdf`, and `/Users/tina/Desktop/IELTS_9月範囲.pdf`.
- Keep the existing 20-question trial sets unchanged.
- Normal days remain 20 questions and 300 seconds; review days use 50 questions and 750 seconds.
- Each review set contains 8 or 9 questions from every preceding study day and prioritizes questions with recorded mistakes.
- Long-term persistence stores aggregates, not participants' raw answer strings.
- Do not alter `RESULTS_ADMIN_PASSWORD` or the private result-history authentication flow.
- Do not deploy until the local data, server, UI, persistence, and 100-client checks pass.

---

### Task 1: Import and validate the approved September datasets

**Files:**
- Create: `scripts/import-september-pdfs.py`
- Create: `data/wordtests/clacel-2026-09.json`
- Create: `data/wordtests/toeic-2026-09.json`
- Create: `data/wordtests/ielts-2026-09.json`
- Create: `data/wordtests/manifest-2026-09.json`
- Create: `tests/september-wordtests.test.js`

**Interfaces:**
- Consumes: three PDF paths passed through `--clacel`, `--toeic`, and `--ielts`.
- Produces: JSON objects shaped as `{ label, datasetRevision, series: Array<{ name, day, items }> }`; each item contains `questionId`, `sentence`, `answer`, `base`, `hint`, `ja`, and `sentenceJa`.

- [ ] **Step 1: Write the failing dataset contract test**

```js
test("approved September datasets have exact day and item counts", () => {
  assert.deepEqual(clacel.series.map(({ day }) => day), STUDY_DAYS);
  assert.equal(clacel.series.flatMap(({ items }) => items).length, 420);
  assert.equal(toeic.series.flatMap(({ items }) => items).length, 440);
  assert.equal(ielts.series.flatMap(({ items }) => items).length, 440);
});

test("no clue leaks its answer", () => {
  for (const item of allItems) {
    const clue = `${item.sentence.replaceAll("___", "")} ${item.ja}`.toLowerCase();
    assert.equal(containsStandaloneAnswer(clue, item.answer), false, item.questionId);
  }
});
```

- [ ] **Step 2: Run the test and verify that the JSON files are missing**

Run: `node --test tests/september-wordtests.test.js`

Expected: FAIL because `data/wordtests/*-2026-09.json` does not exist.

- [ ] **Step 3: Implement the offline PDF importer**

```python
def make_question(course, day, number, word_row, practice_row, answer):
    return {
        "questionId": f"2026-09/{course}/day{day:02d}/q{number:02d}",
        "sentence": practice_row.sentence,
        "answer": answer.lower(),
        "base": word_row.headword.lower(),
        "hint": word_row.headword[0].lower() + "_" * (len(word_row.headword) - 1),
        "ja": word_row.meaning,
        "sentenceJa": word_row.translation,
    }

if question["questionId"] == "2026-09/clacel/day01/q13":
    question["ja"] = "OをCのままにしておく、置き忘れる、去る"
```

The importer must identify each Day page, read the numbered practice questions and answer key, match the corresponding vocabulary row, and fail when counts or mappings are ambiguous. Write the PDF SHA-256 values and generated dataset revisions to `manifest-2026-09.json`.

- [ ] **Step 4: Generate the JSON datasets from the approved PDFs**

Run:

```bash
python3 scripts/import-september-pdfs.py \
  --clacel '/Users/tina/Desktop/Clacel_9月範囲.pdf' \
  --toeic '/Users/tina/Desktop/TOEIC_9月範囲.pdf' \
  --ielts '/Users/tina/Desktop/IELTS_9月範囲.pdf'
```

Expected: `clacel=420`, `toeic=440`, `ielts=440`, and `answer_leaks=0`.

- [ ] **Step 5: Run the dataset test**

Run: `node --test tests/september-wordtests.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the imported dataset**

```bash
git add scripts/import-september-pdfs.py data/wordtests tests/september-wordtests.test.js
git commit -m "feat: import approved September vocabulary data"
```

---

### Task 2: Load immutable JSON data and remove browser editing

**Files:**
- Modify: `wordtests.js`
- Modify: `server.js`
- Delete: `public/admin-words.html`
- Modify: `tests/trial-wordtests.test.js`
- Modify: `tests/brand-title-style.test.js`
- Create: `tests/admin-words-removed.test.js`

**Interfaces:**
- Consumes: the three generated dataset JSON files plus the existing trial series.
- Produces: `WORDTESTS[category].series` with trial, study days, and review-day descriptors; no writable word-test HTTP API.

- [ ] **Step 1: Write failing removal and loader tests**

```js
test("word editor page and API are unavailable", async () => {
  assert.equal((await fetch(`${baseUrl}/admin-words.html`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/admin/wordtests/clacel`)).status, 404);
});

test("runtime data comes from the approved JSON revision", () => {
  assert.equal(WORDTESTS.clacel.series.find((s) => s.name === "Day 25").items.length, 10);
  assert.equal(WORDTESTS.clacel.series.some((s) => s.name === "Day 26"), false);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tests/admin-words-removed.test.js tests/trial-wordtests.test.js tests/brand-title-style.test.js`

Expected: FAIL because the page and API still exist and the old JavaScript datasets are loaded.

- [ ] **Step 3: Implement the immutable loader and delete editor code**

```js
const COURSE_DATA = {
  clacel: require("./data/wordtests/clacel-2026-09.json"),
  toeic: require("./data/wordtests/toeic-2026-09.json"),
  ielts: require("./data/wordtests/ielts-2026-09.json"),
};

module.exports = Object.fromEntries(Object.entries(COURSE_DATA).map(([category, data]) => [
  category,
  { ...data, series: [existingTrial(category), ...withReviewDescriptors(data.series)] },
]));
```

Remove `ADMIN_PASSWORD`, `WORDTESTS_FILES`, `checkAdminAuth`, `validateWordtestsData`, `serializeWordtestsFile`, and both `/api/admin/wordtests/:category` routes. Delete `public/admin-words.html` and remove it from brand-page test expectations.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/admin-words-removed.test.js tests/trial-wordtests.test.js tests/brand-title-style.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the immutable loader and editor removal**

```bash
git add wordtests.js server.js public/admin-words.html tests
git commit -m "feat: make vocabulary data immutable"
```

---

### Task 3: Persist complete per-question daily aggregates

**Files:**
- Modify: `server.js`
- Modify: `tests/quiz-room-persistence.test.js`
- Modify: `tests/results-history-api.test.js`

**Interfaces:**
- Consumes: `room.questions[*].questionId`, participant submission scores, and mistake reasons.
- Produces: `resultHistory[date:category].questionStats`, where each entry has `{ questionId, attempts, wrongCount, reasonCounts }`.

- [ ] **Step 1: Write failing persistence and idempotency tests**

```js
assert.equal(saved.resultHistory[key].questionStats.length, room.questions.length);
assert.deepEqual(saved.resultHistory[key].questionStats[0], {
  questionId: "2026-09/clacel/day01/q01",
  attempts: 3,
  wrongCount: 2,
  reasonCounts: { spelling: 1, blank: 1 },
});
assert.equal(revealingAgain.resultHistory[key].questionStats[0].wrongCount, 2);
```

- [ ] **Step 2: Run the focused persistence tests and verify failure**

Run: `node --test tests/quiz-room-persistence.test.js tests/results-history-api.test.js`

Expected: FAIL because history currently stores only participant count and perfect names, while room results retain only three mistakes.

- [ ] **Step 3: Build complete aggregate records before top-three presentation data**

```js
function buildQuestionStats(room, participants) {
  return room.questions.map((question, index) => ({
    questionId: question.questionId,
    attempts: participants.length,
    wrongCount: participants.filter((p) => p.wrongQuestionIndexes.includes(index)).length,
    reasonCounts: aggregateReasonCounts(participants, index),
  }));
}

const questionStats = buildQuestionStats(room, participants);
const mistakes = topThreeMistakes(questionStats, room.questions);
```

Store `datasetRevision`, `day`, and `questionStats` in the daily history record. Keep the existing public results payload limited to the top three mistakes.

- [ ] **Step 4: Sanitize legacy and new persisted state**

On restore, treat missing `questionStats` as an empty array. Reject negative counts, unknown reason keys, invalid question IDs, and `wrongCount > attempts`.

- [ ] **Step 5: Run persistence and history tests**

Run: `node --test tests/quiz-room-persistence.test.js tests/results-history-api.test.js`

Expected: PASS, including old-state migration and replacement without double counting.

- [ ] **Step 6: Commit aggregate persistence**

```bash
git add server.js tests/quiz-room-persistence.test.js tests/results-history-api.test.js
git commit -m "feat: persist full daily question statistics"
```

---

### Task 4: Select and run balanced 50-question review days

**Files:**
- Create: `quiz-review-selection.js`
- Create: `tests/quiz-review-selection.test.js`
- Modify: `server.js`
- Modify: `public/quiz.html`
- Modify: `tests/quiz-screen.test.js`
- Modify: `tests/quiz-room-persistence.test.js`

**Interfaces:**
- Consumes: `selectReviewQuestions({ category, reviewDay, datasetRevision, series, resultHistory, random })`.
- Produces: `{ questions, sourceDays, durationSec: 750 }` with exactly 50 unique questions and 8 or 9 from each source day.

- [ ] **Step 1: Write failing pure selection tests**

```js
const selected = selectReviewQuestions(fixture);
assert.equal(selected.questions.length, 50);
assert.equal(new Set(selected.questions.map((q) => q.questionId)).size, 50);
assert.deepEqual(countByDay(selected.questions), { 1: 9, 2: 8, 3: 8, 4: 9, 5: 8, 6: 8 });
assert.ok(selected.questions.includes(highMistakeQuestion));
```

Add cases for no history, partial history, tied rates, a 12-question source day, and fewer than 50 unique source questions.

- [ ] **Step 2: Run the pure tests and verify failure**

Run: `node --test tests/quiz-review-selection.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure selector**

```js
const REVIEW_SOURCE_DAYS = {
  7: [1, 2, 3, 4, 5, 6],
  14: [8, 9, 10, 11, 12, 13],
  21: [15, 16, 17, 18, 19, 20],
};

function selectReviewQuestions(input) {
  const quotas = allocateDailyQuotas(input); // four 8s and two 9s
  const selected = input.sourceDays.flatMap((day) => selectForDay(day, quotas[day], input));
  if (selected.length !== 50 || new Set(selected.map((q) => q.questionId)).size !== 50) {
    throw new ReviewSelectionError("復習問題を50問作成できませんでした");
  }
  return { questions: shuffle(selected, input.random), sourceDays: input.sourceDays, durationSec: 750 };
}
```

- [ ] **Step 4: Integrate review descriptors into room start**

For a normal series, preserve 20 questions and 300 seconds. For a review descriptor, call `selectReviewQuestions`, persist its returned questions before emitting `quiz:started`, and use `endsAt = startedAt + 750000`.

- [ ] **Step 5: Update host labels and question-count assumptions**

Render `Day 7（復習50問）`, `Day 14（復習50問）`, and `Day 21（復習50問）`. Derive all participant progress, submission confirmation, scoring denominator, and result labels from `room.questions.length`; do not hard-code 20.

- [ ] **Step 6: Run selector, screen, and restart tests**

Run: `node --test tests/quiz-review-selection.test.js tests/quiz-screen.test.js tests/quiz-room-persistence.test.js`

Expected: PASS, including stable questions and deadline after process restart.

- [ ] **Step 7: Commit review-day behavior**

```bash
git add quiz-review-selection.js server.js public/quiz.html tests
git commit -m "feat: add balanced mistake-prioritized review days"
```

---

### Task 5: Full regression, load validation, and production handoff

**Files:**
- Modify: `scripts/test-quiz-load.js`
- Modify: `package.json`
- Modify: `DEPLOYMENT.md`

**Interfaces:**
- Consumes: final runtime behavior from Tasks 1–4.
- Produces: repeatable normal-day and review-day 100-client verification commands and an updated deployment checklist.

- [ ] **Step 1: Extend the load test with a 50-question review room**

```js
assert.equal(reviewStarted.total, 50);
assert.equal(reviewStarted.endsAt - reviewStarted.startedAt, 750_000);
assert.equal(new Set(reviewStarted.questions.map((q) => q.questionId)).size, 50);
```

Run one host and 99 participants, submit mixed answers, reveal results, restart the server from the same state file, and verify the room plus daily aggregates.

- [ ] **Step 2: Run all local checks**

Run:

```bash
npm test
npm run test:load
git diff --check
```

Expected: all tests pass, 100-client normal and review scenarios pass, and Git reports no whitespace errors.

- [ ] **Step 3: Perform the negative checks**

Run a fixture with 49 unique review candidates and expect room start to return the Japanese error. Request `/admin-words.html` and `/api/admin/wordtests/clacel` and expect 404. Search all generated data for standalone answer leakage and expect zero findings.

- [ ] **Step 4: Update deployment documentation**

Document that content updates now use the PDF importer and Git, `ADMIN_PASSWORD` is obsolete, `RESULTS_ADMIN_PASSWORD` remains required, and review days require the existing `/data` volume.

- [ ] **Step 5: Commit verification and documentation**

```bash
git add scripts/test-quiz-load.js package.json DEPLOYMENT.md
git commit -m "test: cover September review-day production flow"
```

- [ ] **Step 6: Rebase, push, merge, and verify Railway**

Create a `codex/` implementation branch before code changes, rebase it onto current `origin/main`, push it, open a pull request, wait for CI, merge only the verified SHA, and confirm Railway deployed that merge SHA. Then verify `/healthz`, one normal room, one review room, reconnect behavior, timeout behavior, result history, the `leave` clue, and both removed editor URLs on the production hostname.
