# Results History, Trial Sets, and Weekly Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three 20-question trial sets, durable admin-only daily result history, correct mistake aggregation, direct confirmation editing, and same-browser weekly mistake review without adding a Railway service.

**Architecture:** Keep authoritative rooms and result history in one version-2 atomic JSON snapshot on the existing Railway `/data` volume. Keep personal weekly mistakes in browser `localStorage`, with pure date/retention helpers in `public/ui-logic.js`. Add a cookie-authenticated results-history API and a static monthly-calendar page.

**Tech Stack:** Node.js 24, Express 4, Socket.IO 4, plain HTML/CSS/JavaScript, Node test runner, jsdom.

**Spec:** `docs/superpowers/specs/2026-09-03-results-history-and-weekly-review-design.md`

## Global Constraints

- Formal Day 1 starts at 2026-09-06 19:30 Asia/Tokyo.
- The 2026-09-05 trial is saved to admin history but excluded from weekly browser review.
- Reuse existing September items verbatim; do not reorder or remove formal Day items.
- Do not store raw participant answers, response times, all scores, names, or room tokens in weekly review.
- Do not add a Railway service, database, volume, or dependency.
- Preserve unrelated homepage, quiz, and word-list behavior.

---

### Task 1: Trial problem sets and project-day calendar

**Files:**
- Modify: `wordtests-clacel.js`
- Modify: `wordtests-toeic.js`
- Modify: `wordtests-ielts.js`
- Modify: `public/ui-logic.js`
- Modify: `tests/ui-logic.test.js`
- Create: `tests/trial-wordtests.test.js`

**Interfaces:**
- Consumes: existing word-test item objects.
- Produces: `series[0] = { name: "体験会", isTrial: true, items: Item[20] }`; `QuizUi.getStudyDay(date)` anchored to 2026-09-06; `QuizUi.getProjectWeek(date)`.

- [ ] **Step 1: Write failing tests for trial sets and the new Day 1.** Assert each trial has exactly 20 unique bases; every trial item deep-equals an item in an existing formal Day series; formal series names/items remain unchanged; Sep 5 has no formal Day and Sep 6 is Day 1.
- [ ] **Step 2: Run `node --test tests/trial-wordtests.test.js tests/ui-logic.test.js` and verify failures mention the missing trial series and old Sep 1 anchor.**
- [ ] **Step 3: Add hand-selected easy existing items to each trial series and change the pure calendar helpers.** The week helper returns `null` before `2026-09-06T19:30:00+09:00`, otherwise `{ id, startsAt, endsAt }` for seven-day intervals.
- [ ] **Step 4: Re-run the two tests and all three validators; verify all pass.**
  - `node scripts/validate-wordtests.js wordtests-clacel.js 20,20,19,20,20,20,20,20,12,20,20,20,20,20,20,20,19,20,20,20,20,20,20,20,20,19,20`
  - `node scripts/validate-wordtests.js wordtests-toeic.js 20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20`
  - `node scripts/validate-wordtests.js wordtests-ielts.js 20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,20`
- [ ] **Step 5: Commit `feat: add September trial quiz sets`.**

### Task 2: Version-2 persistence and result history transaction

**Files:**
- Modify: `server.js`
- Modify: `tests/quiz-room-persistence.test.js`

**Interfaces:**
- Consumes: participant `wrongQuestionIndexes: number[]`, room `category`, `setLabel`, `isTrial`.
- Produces: snapshot `{ version: 2, rooms, resultHistory }`; history key `${yyyyMmDd}:${category}`; result payload `{ setLabel, perfect, others, review, mistakes, isTrial }`.

- [ ] **Step 1: Add failing integration tests.** Cover v1 migration, v2 restart restoration, same-day/category replacement, cross-category coexistence, host close preserving history, and write failure rolling back both finished room and history.
- [ ] **Step 2: Add failing submission/result tests.** Submit two literal answer arrays with known wrong indexes and assert top-three ordering by wrong count then question order, participant count, perfect names without `timeMs`, and zero mistakes as `[]`.
- [ ] **Step 3: Run `node --test tests/quiz-room-persistence.test.js` and verify failures are caused by missing v2/history/mistake behavior.**
- [ ] **Step 4: Implement one `quizState = { rooms, resultHistory }` authority, serialization, v1 migration, clone/rollback, and Tokyo date key generation.** Persist `wrongQuestionIndexes`; forced non-submitters receive all indexes; attach `isTrial` at start.
- [ ] **Step 5: Implement atomic result finalization.** Build `perfectNames`, `participantCount`, and `mistakes: [{ index, answer, ja, count }]`; update history and finished room inside the same mutation and omit response times from saved/admin data.
- [ ] **Step 6: Run the persistence test file and full `npm test`; verify all pass.**
- [ ] **Step 7: Commit `feat: persist daily quiz results and mistake counts`.**

### Task 3: Dedicated results-history authentication API

**Files:**
- Modify: `server.js`
- Create: `tests/results-history-api.test.js`

**Interfaces:**
- Produces: `POST /api/results-history/login`, `POST /api/results-history/logout`, `GET /api/results-history?month=YYYY-MM`, `DELETE /api/results-history/:date/:category`.
- Cookie: signed with an HMAC derived from `RESULTS_ADMIN_PASSWORD`, 12-hour expiry, `HttpOnly; Secure` in production, `SameSite=Strict; Path=/`.

- [ ] **Step 1: Write failing real-server tests.** Assert 503 when unset, 401 for wrong passwords, 429 after repeated failures, valid login cookie, no password in response/storage, month filtering, record deletion, logout expiry, and `Cache-Control: no-store`.
- [ ] **Step 2: Run `node --test tests/results-history-api.test.js`; verify endpoint-not-found failures.**
- [ ] **Step 3: Implement timing-safe password comparison, an in-memory IP failure window, HMAC cookie creation/verification, month validation, sanitized history output, deletion through atomic persistence, and logout.**
- [ ] **Step 4: Re-run API tests and persistence tests; verify all pass.**
- [ ] **Step 5: Commit `feat: protect results history API`.**

### Task 4: Monthly results-history calendar

**Files:**
- Create: `public/results-history.html`
- Create: `tests/results-history-screen.test.js`

**Interfaces:**
- Consumes the Task 3 API only with `credentials: "same-origin"`.
- Produces login, calendar month navigation, selected-date details for three courses, logout, and confirmed per-course deletion.

- [ ] **Step 1: Write failing jsdom tests against literal history fixtures.** Assert the login screen, calendar day dots, date selection, participant/perfect counts, all perfect names, zero-perfect copy, missing-course copy, prior/next month requests, and failed deletion preserving the card.
- [ ] **Step 2: Run `node --test tests/results-history-screen.test.js`; verify failure because the page is missing.**
- [ ] **Step 3: Build the responsive static page.** Render with `textContent`/escaped values, never persist passwords, announce API errors with `role="alert"`, and require `confirm()` before DELETE.
- [ ] **Step 4: Re-run the screen and API tests; verify all pass.**
- [ ] **Step 5: Commit `feat: add admin results calendar`.**

### Task 5: Quiz result, confirmation, and room-close fixes

**Files:**
- Modify: `public/quiz.html`
- Modify: `tests/quiz-screen.test.js`

**Interfaces:**
- Consumes `quiz:results.mistakes` and `quiz:results.isTrial` from Task 2.
- Produces a host top-three section that is hidden when empty; confirmation-origin edit state; retest Japanese example display; room-close message without interrupting local retest/results.

- [ ] **Step 1: Add failing jsdom tests for each visible regression.** Test no lobby “前回の間違い20語”, top-three rows and counts, hidden empty top-three, no “全員正解でした”, direct return to confirmation after editing question 7 and then question 12, `sentenceJa` in retest, and room closure leaving `screen-results`/`screen-retest` visible.
- [ ] **Step 2: Run the named quiz screen tests and verify each fails for the intended old behavior.**
- [ ] **Step 3: Remove the lobby history card/call, render host mistake rows only when non-empty, and keep the perfect-zero sentence only in its own section.**
- [ ] **Step 4: Add `editingFromConfirmation`; when true, label the action `確認一覧へ戻る`, save one answer, reset the flag, and call `showSubmitConfirmation()` instead of incrementing.**
- [ ] **Step 5: Include `sentenceJa` in retest items and markup. On `quiz:roomClosed`, clear room session but show an inline notice and preserve local-only results/retest screens.**
- [ ] **Step 6: Run `node --test tests/quiz-screen.test.js` and full `npm test`; verify all pass.**
- [ ] **Step 7: Commit `fix: correct quiz review and confirmation flows`.**

### Task 6: Weekly same-browser mistake review

**Files:**
- Modify: `public/ui-logic.js`
- Modify: `public/quiz.html`
- Modify: `tests/ui-logic.test.js`
- Modify: `tests/quiz-screen.test.js`

**Interfaces:**
- Produces local key `oshQuizWeeklyMistakesV1` containing `{ weekId, records: [{ at, category, setLabel, words }] }`; word fields are `answer`, `altAnswers`, `ja`, `sentence`, `sentenceJa`.
- Uses `QuizUi.getProjectWeek(date)` from Task 1; trial results are never written.

- [ ] **Step 1: Add failing pure tests for the exact 19:30 JST boundary.** Test 19:29:59 vs 19:30:00 on Sep 6 and Sep 13, pruning old weeks, max 420 words, and malformed local data returning empty state.
- [ ] **Step 2: Add failing screen tests.** Assert non-trial mistakes are saved without personal fields; trial mistakes are not saved; “今週の間違いを解く（N語）” appears only with current-week data; clicking it starts all current-week records; and Japanese example text is rendered.
- [ ] **Step 3: Run both test files and verify the missing helper/storage/entry failures.**
- [ ] **Step 4: Implement read/prune/write helpers and replace the old latest-mistake record.** Read only the count for initial entry rendering; load full words only when review begins.
- [ ] **Step 5: Add the weekly-review entry and limitation note. Preserve same-week items even after they are answered correctly in a retest.**
- [ ] **Step 6: Run both test files and full `npm test`; verify all pass.**
- [ ] **Step 7: Commit `feat: add same-browser weekly mistake review`.**

### Task 7: Documentation, load test, and production deployment

**Files:**
- Modify: `DEPLOYMENT.md`
- Create: `scripts/test-quiz-load.js`
- Modify: `package.json`
- Create: `tests/load-script.test.js`

**Interfaces:**
- Produces `npm run test:load` for one host plus 99 participants and documented `RESULTS_ADMIN_PASSWORD` deployment/rotation procedure.

- [ ] **Step 1: Write a failing test that launches the load script against a temporary real server and expects 99 joins, 99 submits, a result reveal, top-three aggregation, and a saved history record.**
- [ ] **Step 2: Run `node --test tests/load-script.test.js` and verify the missing-script failure.**
- [ ] **Step 3: Implement the bounded load script with real Socket.IO clients and add `test:load`; update deployment docs with the new secret, `/data` backup note, login URL, deletion, and rollback checks.**
- [ ] **Step 4: Run `npm test`, `npm run test:load`, and `npm audit --omit=dev`; record exact results.**
- [ ] **Step 5: Use `fable-check`, `superpowers:requesting-code-review`, and `superpowers:verification-before-completion`; fix only in-scope findings and rerun affected tests.**
- [ ] **Step 6: Push the feature branch, open a PR, verify required GitHub checks, merge through protected `main`, and confirm Railway deploys that exact merge SHA.**
- [ ] **Step 7: Set a generated strong `RESULTS_ADMIN_PASSWORD` in Railway without logging it, then verify production login, trial set selection, a disposable history record, restart restoration, deletion, and cleanup.**
- [ ] **Step 8: Commit documentation/test harness changes as `docs: add results history operations guide` before PR creation.**
