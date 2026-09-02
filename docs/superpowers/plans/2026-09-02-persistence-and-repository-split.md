# Quiz Persistence and Repository Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist active quiz rooms, fit the desktop home in one viewport, and migrate production to a small protected application repository.

**Architecture:** Quiz state is written atomically to the existing Railway volume and restored before accepting connections. The deployable application becomes a clean repository while the course-production subtree moves to a private repository; the existing Railway service and domain stay unchanged.

**Tech Stack:** Node.js 24, Express 4, Socket.IO 4, node:test, Chrome DevTools Protocol, GitHub Actions, Railway GraphQL API

**Spec:** `docs/superpowers/specs/2026-09-02-persistence-and-repository-split-design.md`

## Global Constraints

- Preserve the existing Railway project, service, domain, variables, and `/data` volume.
- Never deploy with `railway up`.
- Do not delete or publish untracked local files.
- Do not archive the old repository until the new production deployment passes behavioral verification.

---

### Task 1: Persistent room lifecycle

**Files:**
- Modify: `server.js`
- Modify: `public/quiz.html`
- Create: `tests/quiz-room-persistence.test.js`
- Modify: `tests/quiz-screen.test.js`
- Modify: `tests/helpers/loadQuizPage.js`

**Interfaces:**
- Consumes: `QUIZ_ROOM_STATE_FILE`, defaulting to `/data/quiz-rooms.json` when `/data` exists.
- Produces: restart-safe `quiz:rejoin`, explicit `quiz:leave`, and `quiz:roomClosed`.

- [x] Write an integration test that creates a room, restarts the real server, rejoins with both saved tokens, explicitly exits the host, and verifies the persisted room is deleted.
- [x] Run `node --test --test-concurrency=1 tests/quiz-room-persistence.test.js` and verify it fails because no state file is created.
- [x] Implement atomic room snapshots, startup restoration, timer restoration, explicit host closure, disconnect retention, and client `localStorage` recovery.
- [x] Run the persistence and UI tests and verify they pass.

### Task 2: One-viewport desktop home

**Files:**
- Modify: `public/index.html`
- Create: `tests/home-viewport.test.js`

**Interfaces:**
- Consumes: the existing home markup and illustration.
- Produces: a 1440 by 800 desktop layout with `scrollHeight <= innerHeight` and no horizontal overflow.

- [x] Add a real headless-Chrome viewport test.
- [x] Run the test and record the failing 1456px document height against a 657px inner viewport.
- [x] Reduce desktop spacing and scale the illustration and course rows without removing content.
- [x] Run the viewport test and inspect 1512 by 982 and 1440 by 800 screenshots.

### Task 3: Create separated GitHub repositories

**Files:**
- Create repository: `xingaiyuyao-commits/gra-commu-vocab-app`
- Create repository: `xingaiyuyao-commits/osh-vocab-content`

**Interfaces:**
- Consumes: reviewed commit on `codex/persistent-quiz-rooms` and the tracked `osh-vocab-test` subtree.
- Produces: app `main` and content `main` repositories.

- [x] Push the feature branch and merge it only after GitHub Actions succeeds.
- [x] Create a clean application snapshot containing tracked runtime, tests, and deployment documentation but no `osh-vocab-test` or patch artifacts.
- [x] Initialize and push `gra-commu-vocab-app` as a public repository.
- [x] Run `git subtree split --prefix=osh-vocab-test main` and push the result to private `osh-vocab-content`.
- [x] Compare file counts and run `npm ci && npm run test:deploy` in a fresh clone of the app repository.

### Task 4: Protect the new main branch

**Files:**
- GitHub repository settings only.

**Interfaces:**
- Consumes: successful `deploy-check / test` on the new app repository.
- Produces: required pull request and `test` status, with force push and deletion disabled.

- [x] Apply branch protection through the GitHub API with zero required approvals.
- [x] Read the protection settings back and verify the required context, PR rule, force-push rule, and deletion rule.

### Task 5: Switch Railway source safely

**Files:**
- Railway service settings only.

**Interfaces:**
- Consumes: `xingaiyuyao-commits/gra-commu-vocab-app` `main` and service ID `592009e6-2f6f-4a9d-bd57-bda47f2c2f38`.
- Produces: the existing production URL served from the new repository.

- [x] Record the current source, latest healthy deployment ID, and commit SHA through read-only Railway queries.
- [x] Verify Railway can access the new GitHub repository.
- [x] Run `serviceConnect(id, {repo, branch})` for the existing service; do not create a second service.
- [x] Wait for CI and Railway deployment success and verify the exact GitHub commit SHA.
- [x] Test `/healthz`, the 1440 by 800 home, a participant join, a restart and token rejoin, and organizer room closure on production.
- [x] If any check fails, reconnect the recorded old source and redeploy it.

### Task 6: Cleanup and archive

**Files:**
- Modify: `osh-vocab-test/progress.md`
- Remove from new app snapshot: `REDEPLOY.md`, patch artifacts
- Remove: completed local worktree after merge

**Interfaces:**
- Consumes: verified new-source production deployment.
- Produces: canonical documentation, archived old repo, and no completed worktree.

- [x] Mark the old `railway up` note as superseded by `DEPLOYMENT.md` without rewriting historical results.
- [x] Archive `xingaiyuyao-commits/gra-commu-vocab-test` only after all production checks pass.
- [x] Confirm all untracked local files still exist and remain uncommitted.
- [x] Remove the completed worktree and prune worktree metadata.
