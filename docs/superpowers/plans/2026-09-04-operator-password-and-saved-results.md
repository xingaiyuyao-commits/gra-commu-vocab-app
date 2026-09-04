# Operator Password and Saved Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict all host operations to a 12-hour shared-password session while letting participants reopen each day's result and review from that day's invite link for seven days.

**Architecture:** Add a small operator-auth module and cookie-authenticated HTTP API, then require the same signed cookie for every host-only Socket.IO action. Store sanitized participant result snapshots in browser `localStorage`, keyed by room code with a rolling seven-day TTL and 21-record cap; a closed invite link restores only its matching local snapshot.

**Tech Stack:** Node.js 24, Express 4, Socket.IO 4, browser HTML/CSS/JavaScript, Node test runner, JSDOM.

**Spec:** `docs/superpowers/specs/2026-09-04-operator-password-and-review-return-design.md`

## Global Constraints

- Use one shared `OPERATOR_PASSWORD`, separate from `RESULTS_ADMIN_PASSWORD`.
- Never put the password in Git, HTML, JavaScript, a URL, logs, or browser storage.
- Keep participant invite, answer, submit, and review actions public.
- Hide participant result-screen exit and home navigation.
- Use a new room code and invite link for every daily run.
- Save each participant result locally for exactly seven days, capped at 21 records.
- Do not add a paid service or server-side participant-result database.
- Implement each behavior test-first and preserve the existing 100-client gate.

---

### Task 1: Operator authentication primitives and HTTP API

**Files:**
- Create: `operator-auth.js`
- Create: `tests/operator-auth.test.js`
- Create: `tests/operator-auth-api.test.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `createOperatorAuth({ password, secureCookie, now, randomBytes })` returning `passwordMatches`, `makeSessionToken`, `sessionTokenIsValid`, `sessionCookie`, `clearCookie`, and `cookieToken`.
- Produces HTTP endpoints: `POST /api/operator/login`, `POST /api/operator/logout`, `GET /api/operator/session`.

- [ ] **Step 1: Write failing primitive tests**

Cover correct and incorrect passwords, valid/expired/malformed tokens, token invalidation after password rotation, cookie parsing, and `HttpOnly; SameSite=Strict; Path=/; Secure` attributes.

- [ ] **Step 2: Run the primitive test and verify RED**

Run: `node --test tests/operator-auth.test.js`

Expected: FAIL because `operator-auth.js` does not exist.

- [ ] **Step 3: Implement the minimal auth module**

Use SHA-256 only for timing-safe comparison of the configured high-entropy secret and HMAC-SHA-256 for the opaque 12-hour session token. Derive the signing key from the password and the fixed context `operator-session-v1`, so password rotation invalidates old tokens.

- [ ] **Step 4: Run the primitive test and verify GREEN**

Run: `node --test tests/operator-auth.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing API integration tests**

Start the real server with a temporary quiz state file. Assert: missing `OPERATOR_PASSWORD` returns 503; wrong password returns 401; five failures return 429; correct password sets the secure 12-hour cookie; session returns 200 only with a valid cookie; logout clears it; response cache policy is `no-store`.

- [ ] **Step 6: Run the API test and verify RED**

Run: `node --test tests/operator-auth-api.test.js`

Expected: FAIL with missing `/api/operator/*` routes.

- [ ] **Step 7: Add the API routes and throttling to `server.js`**

Create a bounded in-memory failure map, reuse the Railway-aware trusted client-IP normalization pattern, return generic login errors, and never log the request body or cookie.

- [ ] **Step 8: Run auth tests and verify GREEN**

Run: `node --test tests/operator-auth.test.js tests/operator-auth-api.test.js`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add operator-auth.js server.js tests/operator-auth.test.js tests/operator-auth-api.test.js
git commit -m "feat: add operator password authentication"
```

### Task 2: Private pre-login and conditional home action

**Files:**
- Create: `public/operator-login.html`
- Create: `tests/operator-login-screen.test.js`
- Modify: `public/index.html`
- Modify: `tests/home-screen.test.js`
- Modify: `public/quiz.html`
- Modify: `tests/quiz-screen.test.js`

**Interfaces:**
- Consumes: `GET/POST /api/operator/session|login` from Task 1.
- Produces: `#operator-entry` hidden by default on the home page and revealed only after authenticated API response.
- Produces: create-mode UI guard that redirects unauthenticated browsers to `/operator-login.html`.

- [ ] **Step 1: Write failing screen tests**

Assert that the login page uses the shared-password field, successful login returns to `/`, wrong login shows a generic error, the home action remains hidden on 401 and appears on 200, and `quiz.html?mode=create` does not reveal host controls before authentication.

- [ ] **Step 2: Run screen tests and verify RED**

Run: `node --test tests/operator-login-screen.test.js tests/home-screen.test.js tests/quiz-screen.test.js`

Expected: FAIL because the login page and conditional action do not exist.

- [ ] **Step 3: Implement the branded login page and conditional home action**

Keep the VOICE logo, ÖSH title typography, and existing monochrome/gold visual system. Submit with `fetch`, reload/redirect only after a successful response, and keep the password out of all storage.

- [ ] **Step 4: Implement the create-mode guard**

Hide the create container before session validation; reveal it after a 200 session response; redirect to the login page on 401/503. Reload after login so Socket.IO reconnects with the new cookie.

- [ ] **Step 5: Run screen tests and verify GREEN**

Run: `node --test tests/operator-login-screen.test.js tests/home-screen.test.js tests/quiz-screen.test.js`

Expected: PASS without a visible unauthorized flash.

- [ ] **Step 6: Commit**

```bash
git add public/operator-login.html public/index.html public/quiz.html tests/operator-login-screen.test.js tests/home-screen.test.js tests/quiz-screen.test.js
git commit -m "feat: gate host UI behind operator login"
```

### Task 3: Enforce operator authorization on every host action

**Files:**
- Create: `tests/operator-socket-auth.test.js`
- Modify: `server.js`
- Modify: `scripts/test-quiz-load.js`
- Modify: `scripts/test-quiz-flow.js`

**Interfaces:**
- Consumes: valid `operator_session` cookie from Task 1.
- Produces: `socketOperatorIsAuthenticated(socket)` and a common `{ ok:false, error:"運営者ログインが必要です" }` rejection.

- [ ] **Step 1: Write failing real Socket.IO integration tests**

Assert that unauthenticated clients cannot create rooms; authenticated clients can; participant join/submit remains public; host rejoin and host-only start, reveal, replay, and close require the cookie; participant leave remains public.

- [ ] **Step 2: Add regression tests for currently emitted host controls**

Assert `quiz:selectSeries` updates the participant-facing next-set metadata and `quiz:cancelGame` returns a playing room to the lobby. These client actions currently have no server handler and must not remain silent no-ops.

- [ ] **Step 3: Run the socket test and verify RED**

Run: `node --test tests/operator-socket-auth.test.js`

Expected: FAIL because unauthenticated creation succeeds and the two host handlers are absent.

- [ ] **Step 4: Implement the common Socket.IO authorization boundary**

Read the signed cookie from the Socket.IO handshake. Gate `quiz:createRoom`, host `quiz:rejoin`, `quiz:selectSeries`, `quiz:startGame`, `quiz:cancelGame`, `quiz:revealResults`, `quiz:playAgain`, and host `quiz:leave`. Do not gate participant join, participant rejoin, submit, or participant leave.

- [ ] **Step 5: Implement select/cancel handlers with persistence**

Validate host identity and room phase, persist mutations atomically, send acknowledgements, and emit the existing `quiz:playersUpdate` or `quiz:backToLobby` events expected by the UI.

- [ ] **Step 6: Pass the operator cookie in load and flow scripts**

Log in once through the real API, extract the cookie, and configure host Socket.IO clients with `extraHeaders.Cookie`. Keep all participant clients unauthenticated.

- [ ] **Step 7: Run socket, flow, and load tests and verify GREEN**

Run: `node --test tests/operator-socket-auth.test.js && node scripts/test-quiz-flow.js && npm run test:load`

Expected: PASS, including one authenticated host plus 99 public participants.

- [ ] **Step 8: Commit**

```bash
git add server.js tests/operator-socket-auth.test.js scripts/test-quiz-flow.js scripts/test-quiz-load.js
git commit -m "feat: enforce operator authorization for host actions"
```

### Task 4: Seven-day saved-result data model

**Files:**
- Modify: `public/ui-logic.js`
- Modify: `tests/ui-logic.test.js`

**Interfaces:**
- Produces: `readSavedQuizResults(raw, now) -> { records }`.
- Produces: `writeSavedQuizResult(raw, record, now) -> { records }`.
- Produces: `findSavedQuizResult(raw, roomCode, now) -> record|null`.
- Record fields: `{ roomCode, category, resultAt, expiresAt, setLabel, answers, results }` with no session token.

- [ ] **Step 1: Write failing pure-function tests**

Use literal fixtures to assert room-code replacement, independent seven-day expiry, a 21-record newest-first cap, malformed-document rejection, missing-token guarantee, exact matching by room code, multiple course/day isolation, and valid full-score/trial records.

- [ ] **Step 2: Run the helper test and verify RED**

Run: `node --test tests/ui-logic.test.js`

Expected: FAIL because the three helpers are undefined.

- [ ] **Step 3: Implement strict sanitization, pruning, and lookup**

Accept only known categories, four-character room codes, finite timestamps, bounded arrays, and review items with required string fields. Set `expiresAt` from the server result timestamp plus `7 * 24 * 60 * 60 * 1000`; never accept a caller-supplied longer expiry.

- [ ] **Step 4: Run helper tests and verify GREEN**

Run: `node --test tests/ui-logic.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/ui-logic.js tests/ui-logic.test.js
git commit -m "feat: add seven day saved quiz results"
```

### Task 5: Save, restore, and simplify the participant result screen

**Files:**
- Modify: `public/quiz.html`
- Modify: `tests/quiz-screen.test.js`

**Interfaces:**
- Consumes: saved-result helpers from Task 4.
- Produces: `saveCurrentParticipantResult(data)`, `restoreSavedResultForPresetRoom()`, and participant result UI with no navigation button.

- [ ] **Step 1: Write failing result-screen tests**

Assert: participant results have no exit/home button; host retains `本日のルームを終了する`; a result is saved before rendering; no session token is copied; save success/failure notes differ; room closure leaves the screen and retest active; retest returns to the result; the same old invite link restores the exact matching result after the server room is gone; a different new code shows normal join; expired, corrupt, and storage-denied cases show `この回は終了しました` safely.

- [ ] **Step 2: Run the result tests and verify RED**

Run: `node --test tests/quiz-screen.test.js`

Expected: FAIL because participant navigation still exists and saved-result restore is absent.

- [ ] **Step 3: Implement result persistence and participant-only rendering**

Persist only after `quiz:results` or a finished rejoin response, using the stable server `resultAt`. Hide/remove the participant result navigation while preserving the host close action. Keep the current in-memory screen active on `quiz:roomClosed`.

- [ ] **Step 4: Restore a matching snapshot from an old invite link**

When `presetRoom` matches a valid saved record and the live room cannot be rejoined, load the saved answers and result payload, render results without writing a duplicate record, and keep all sockets out of a deleted room.

- [ ] **Step 5: Update the remaining vocabulary back-link copy**

Change `← ゲーム選択に戻る` to `← ホームに戻る` outside the result screen. Do not change unrelated legacy game pages.

- [ ] **Step 6: Run result and full UI tests and verify GREEN**

Run: `node --test tests/quiz-screen.test.js tests/ui-logic.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/quiz.html tests/quiz-screen.test.js
git commit -m "feat: restore participant results from invite links"
```

### Task 6: Deployment documentation, full verification, and production release

**Files:**
- Modify: `DEPLOYMENT.md`
- Modify: `package.json`

**Interfaces:**
- Consumes all previous tasks.
- Produces a documented password setup/rotation procedure and CI coverage for all new test files.

- [ ] **Step 1: Add new tests to `test:deploy` and document secret handling**

Document `OPERATOR_PASSWORD`, private pre-login, 12-hour session, rotation invalidation, and the requirement to end active rooms before planned rotation.

- [ ] **Step 2: Run static and full checks**

Run: `git diff --check && npm test && npm run test:load`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 3: Run the mutation/negative checks**

Confirm wrong password, missing password, expired cookie, unauthorized Socket.IO host calls, expired result, different room code, blocked storage, and host room deletion all fail safely while public participant join and submit still work.

- [ ] **Step 4: Use fable-check and review the complete diff**

Search old participant result navigation and public operator-link behavior to zero; enumerate every `quiz:` host event and confirm its authorization decision; scan changed files for debug remnants and documentation contradictions.

- [ ] **Step 5: Commit documentation and CI updates**

```bash
git add DEPLOYMENT.md package.json
git commit -m "docs: add operator authentication deployment checks"
```

- [ ] **Step 6: Push a PR and wait for required CI**

Push `codex/operator-password-review-home`, open a PR to `main`, and merge only after deploy-check succeeds.

- [ ] **Step 7: Configure the production secret without exposing it**

Generate a strong password locally, store it outside Git in the user's macOS Keychain, and set the same value as Railway `OPERATOR_PASSWORD` without printing it in command output. Do not reuse `RESULTS_ADMIN_PASSWORD`.

- [ ] **Step 8: Verify Railway production**

Verify unauthenticated home, private login, authenticated home action, three-course room creation, one public participant join, result reveal, host close, current-screen retest, same-link saved restore, new-code join, `/healthz`, and the 100-client gate against the deployed merge SHA. Remove disposable rooms/history created for verification.
