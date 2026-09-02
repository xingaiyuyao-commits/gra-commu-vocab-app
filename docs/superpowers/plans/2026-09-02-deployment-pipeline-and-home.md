# OSH Vocabulary Challenge Home and Deployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the approved two-column home page and make GitHub CI the single tested source for Railway production deployments.

**Architecture:** Application files remain in the existing repository, but production artifacts must come only from the GitHub `main` commit. A deterministic Node 24 test job gates Railway through Wait for CI, Railway stores `/healthz` as a service setting, and the locally linked Railway CLI is unlinked after rollout so `railway up` cannot accidentally publish an uncommitted workspace.

**Tech Stack:** Node.js 24, Express 4, Socket.IO 4, node:test, JSDOM, GitHub Actions, Railway GitHub Autodeploys

**Spec:** `docs/superpowers/specs/2026-09-02-deployment-pipeline-and-home-design.md`

## Global Constraints

- Production source of truth is `xingaiyuyao-commits/gra-commu-vocab-test` branch `main`.
- Do not use `railway up` during or after this migration.
- Do not delete or alter the `/data` Railway volume, variables, domain, region, or service identity.
- Do not delete, move, add, or broadly ignore the 141 pre-existing user-owned untracked files; the plan file itself temporarily raises the working-tree count to 142 before it is committed.
- Stage only the exact files named by each task; never use `git add .`.
- Preserve `/quiz.html?mode=join`, `/quiz.html?mode=create`, `QuizUi.getStudyDay(new Date())`, and the participant course label behavior.
- The desktop home reference is the screenshot captured at 2026-09-02 11:59; mobile is a one-column responsive layout with no horizontal overflow.
- Node major version is 24 in local development, GitHub Actions, and Railway.

---

### Task 1: Make the committed test suite terminate deterministically

**Files:**
- Modify: `tests/helpers/loadQuizPage.js`
- Modify: `tests/quiz-screen.test.js`
- Modify: `tests/healthz.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadQuizPage(options?: {url?: string})` and the existing `server.js` start command.
- Produces: `npm run test:deploy`, a serial test command that exits 0 on success and nonzero on failure or timeout.

- [ ] **Step 1: Reproduce the current test failures and stop**

Run:

```bash
git ls-files 'tests/*.test.js' | xargs node --test --test-concurrency=1
```

Expected: `tests/healthz.test.js` may exceed 10 seconds and `tests/quiz-screen.test.js` remains pending instead of exiting. Stop the process after the pending condition is observed; do not report the suite as passing.

- [ ] **Step 2: Add explicit JSDOM cleanup to the quiz screen tests**

Change the import at the top of `tests/quiz-screen.test.js` and wrap every existing call without rewriting the individual tests:

```js
const { loadQuizPage: createQuizPage } = require("./helpers/loadQuizPage");

const openQuizPages = [];

function loadQuizPage(options) {
  const page = createQuizPage(options);
  openQuizPages.push(page);
  return page;
}

test.afterEach(() => {
  for (const page of openQuizPages.splice(0)) page.close();
});
```

Extend the return object in `tests/helpers/loadQuizPage.js` with:

```js
close() {
  for (const socket of fakeSockets) socket.disconnect();
  dom.window.close();
},
```

- [ ] **Step 3: Make the health test report startup failures and await shutdown**

Replace the fixed 10-second loop in `tests/healthz.test.js` with a 30-second deadline and collect child stderr:

```js
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

let exited = false;
child.once("exit", () => { exited = true; });

let response;
const deadline = Date.now() + 30_000;
while (!response && !exited && Date.now() < deadline) {
  try {
    response = await fetch(`http://127.0.0.1:${port}/healthz`);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
assert.ok(response, `test server did not become healthy: ${stderr || "no stderr"}`);
```

Replace the existing `t.after` with an awaited cleanup:

```js
t.after(async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
});
```

- [ ] **Step 4: Add a bounded deployment test script**

Add to `package.json`:

```json
"test:deploy": "node --test --test-concurrency=1 tests/healthz.test.js tests/home-screen.test.js tests/join-course-label.test.js tests/quiz-screen.test.js tests/ui-logic.test.js"
```

Keep the existing `test` script unchanged because untracked development tests are outside the deployment gate.

- [ ] **Step 5: Verify the test command exits cleanly twice**

Run:

```bash
npm run test:deploy
npm run test:deploy
```

Expected: both runs finish without manual interruption, exit 0, and report zero failed or cancelled tests.

- [ ] **Step 6: Commit the test stabilization**

```bash
git add package.json tests/healthz.test.js tests/helpers/loadQuizPage.js tests/quiz-screen.test.js
git commit -m "Stabilize production deployment tests"
```

---

### Task 2: Restore the approved two-column home page

**Files:**
- Modify: `public/index.html`
- Modify: `tests/home-screen.test.js`
- Use unchanged asset: `public/assets/osh-vocab-home-illustration.png`

**Interfaces:**
- Consumes: `QuizUi.getStudyDay(date): number | null` and the existing 898×518 PNG.
- Produces: join URL `/quiz.html?mode=join` and creation URL `/quiz.html?mode=create`.

- [ ] **Step 1: Extend the home contract test before changing HTML**

Add literal assertions to `tests/home-screen.test.js` for all approved copy:

```js
for (const copy of [
  "日常から仕事まで、使える英語を。",
  "基礎を積み上げながら、英語を自分の言葉にしていくコースです。",
  "スコアと実務につながる英語を。",
  "頻出語を確実に身につけ、試験にも仕事にも活かします。",
  "海外で学び、暮らすための英語を。",
  "アカデミックな語彙を鍛え、世界へ踏み出す力を育てます。",
  "運営用",
]) assert.ok(html.includes(copy), `${copy} を表示する`);

assert.match(html, /class="home-content"/);
assert.match(html, /@media\s*\(max-width:\s*900px\)/);
```

- [ ] **Step 2: Run the home test and verify the new assertions fail**

Run:

```bash
node --test tests/home-screen.test.js
```

Expected: FAIL because the current vertical home lacks the six description strings, `運営用`, and `.home-content`.

- [ ] **Step 3: Implement the desktop structure in `public/index.html`**

Use this semantic structure while preserving the existing Day script:

```html
<main class="page">
  <h1>ÖSH Vocabulary Challenge</h1>
  <a class="join-cta" href="/quiz.html?mode=join">
    <span>ルームコードを入力して参加する</span><span class="arrow" aria-hidden="true">→</span>
  </a>
  <section class="today-card" id="today-card" aria-labelledby="today-heading" hidden>
    <div><h2 class="today-label" id="today-heading">今日の学習</h2><p class="today-date" id="today-date"></p></div>
    <p class="today-day" id="today-day"></p>
  </section>
  <div class="home-content">
    <figure class="home-illustration">
      <img src="/assets/osh-vocab-home-illustration.png" alt="Clacel・TOEIC・IELTSの単語学習チャレンジ" width="898" height="518" />
    </figure>
    <section class="course-panel" aria-labelledby="course-heading">
      <h2 id="course-heading">CHOOSE YOUR COURSE</h2>
      <a class="course-row" href="/quiz.html?mode=create"><span class="course-number">01</span><span><strong>Clacel</strong><b>日常から仕事まで、使える英語を。</b><small>基礎を積み上げながら、英語を自分の言葉にしていくコースです。</small></span></a>
      <a class="course-row" href="/quiz.html?mode=create"><span class="course-number">02</span><span><strong>TOEIC</strong><b>スコアと実務につながる英語を。</b><small>頻出語を確実に身につけ、試験にも仕事にも活かします。</small></span></a>
      <a class="course-row" href="/quiz.html?mode=create"><span class="course-number">03</span><span><strong>IELTS</strong><b>海外で学び、暮らすための英語を。</b><small>アカデミックな語彙を鍛え、世界へ踏み出す力を育てます。</small></span></a>
      <a class="operator-link" href="/quiz.html?mode=create">運営用</a>
    </section>
  </div>
</main>
```

CSS requirements:

```css
.page { width: min(100%, 1920px); margin: 0 auto; padding: 0 56px 72px; }
h1 { text-align: center; white-space: nowrap; }
.join-cta { width: min(760px, 100%); margin-inline: auto; }
.today-card { width: min(1040px, 100%); margin-inline: auto; }
.home-content { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(520px, .85fr); align-items: start; gap: clamp(48px, 6vw, 110px); }
.home-illustration img { display: block; width: 100%; height: auto; }
.course-row { display: grid; grid-template-columns: 92px 1fr; }
.join-cta, .course-row { min-height: 44px; }
.course-row strong, .course-row b, .course-row small { display: block; }
@media (max-width: 900px) {
  .page { padding-inline: 16px; }
  h1 { white-space: normal; }
  .home-content { grid-template-columns: 1fr; }
}
```

Match spacing and type sizes against the reference screenshot at 2090×1400; do not hardcode `9月1日` or `Day 1`.

- [ ] **Step 4: Verify the home contract and Day logic**

Run:

```bash
node --test tests/home-screen.test.js tests/ui-logic.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Verify PC and mobile rendering**

Start the app on an unused local port and inspect it in a browser at 2090×1400 and 390×844.

At 2090×1400 verify:

- heading is one line and centered;
- CTA and Day box are centered;
- image is left and course copy is right;
- all six exact description strings are visible.

At 390×844 evaluate:

```js
({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
})
```

Expected: `scrollWidth === clientWidth`; content order is heading, CTA, Day, image, courses.

- [ ] **Step 6: Commit the home restoration**

```bash
git add public/index.html tests/home-screen.test.js
git commit -m "Restore approved two-column home"
```

---

### Task 3: Pin Node and add the GitHub deployment gate

**Files:**
- Modify: `package.json`
- Create: `.github/workflows/deploy-check.yml`

**Interfaces:**
- Consumes: `npm run test:deploy` from Task 1.
- Produces: GitHub check suite named `deploy-check / test` on pushes to `main` and pull requests.

- [ ] **Step 1: Add the runtime contract**

Add to `package.json`:

```json
"engines": {
  "node": "24.x"
}
```

- [ ] **Step 2: Create the workflow**

Create `.github/workflows/deploy-check.yml`:

```yaml
name: deploy-check

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run test:deploy
```

- [ ] **Step 3: Validate YAML and local runtime**

Run:

```bash
node -e 'const p=require("./package.json"); if(p.engines.node!=="24.x") process.exit(1)'
npm ci
npm run test:deploy
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit the deployment gate**

```bash
git add package.json package-lock.json .github/workflows/deploy-check.yml
git commit -m "Add GitHub deployment gate"
```

---

### Task 4: Add the runbook and remove the conflicting local config

**Files:**
- Create: `DEPLOYMENT.md`
- Delete after exact-path check: `railway.toml` (currently untracked)

**Interfaces:**
- Consumes: GitHub workflow and Railway service identifiers from the approved spec.
- Produces: one documented deployment procedure and no repository-root `railway.toml` ambiguity.

- [ ] **Step 1: Write the runbook**

Create `DEPLOYMENT.md` with this operational contract:

```markdown
# Production deployment

Production URL: https://gra-commu-vocab-test-production-77e7.up.railway.app/

## Normal path

1. Run `npm run test:deploy`.
2. Commit only the intended files.
3. Push to GitHub `main` through the reviewed branch/PR.
4. Confirm GitHub check `deploy-check / test` succeeds.
5. Confirm Railway deploys the same Git commit SHA and reports SUCCESS.
6. Check `/healthz`, the production HTML, and the visible user flow.

## Prohibited normal operation

Do not use `railway up` for production. It uploads the local working tree and can include untracked files that do not exist in GitHub.

## Rollback

Use `git revert <bad-commit>` and push the revert. Do not deploy an older local folder with `railway up`.
```

- [ ] **Step 2: Verify the conflicting file is exactly the untracked config**

Run:

```bash
git status --short railway.toml
sed -n '1,120p' railway.toml
```

Expected: status is `?? railway.toml`, and the file only contains `/healthz`, timeout, and restart-policy deployment settings already captured in the design.

- [ ] **Step 3: Remove only `railway.toml` with `apply_patch`**

Delete `/Users/tina/Desktop/AI/gra-commu-vocab test/railway.toml`; do not remove `.railwayignore`.

- [ ] **Step 4: Verify no config ambiguity remains**

Run:

```bash
test ! -e railway.toml
git status --short .railwayignore railway.toml DEPLOYMENT.md
```

Expected: `.railwayignore` is unchanged, `railway.toml` is absent, and only `DEPLOYMENT.md` is new.

- [ ] **Step 5: Commit the runbook**

```bash
git add DEPLOYMENT.md
git commit -m "Document the single production deployment path"
```

---

### Task 5: Prepare GitHub without touching production

**Files:**
- No new local files.
- Push branch: `codex/deployment-hardening`.

**Interfaces:**
- Consumes: commits from Tasks 1–4.
- Produces: a reviewable GitHub pull request whose CI succeeds while Railway still deploys only `main`.

- [ ] **Step 1: Run the complete branch verification**

Run:

```bash
npm run test:deploy
git diff --check main...HEAD
git status --short
```

Expected: tests pass, diff check is clean, and existing unrelated untracked files remain untouched.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin codex/deployment-hardening
```

- [ ] **Step 3: Open the pull request**

```bash
gh pr create \
  --base main \
  --head codex/deployment-hardening \
  --title "Restore approved home and harden Railway deployments" \
  --body "Restores the approved two-column home, stabilizes the committed deployment tests, adds a Node 24 GitHub Actions gate, and documents GitHub as the only production source. No Railway volume or environment variables are changed."
```

- [ ] **Step 4: Wait for the pull-request CI**

Run:

```bash
gh pr checks --watch
```

Expected: `deploy-check / test` passes. If it fails, inspect the job log and fix the branch; do not merge.

---

### Task 6: Safely switch Railway to the gated GitHub path

**Files:**
- Railway service setting changes only.
- No application file changes.

**Interfaces:**
- Consumes: successful PR CI from Task 5 and server endpoint `GET /healthz -> 200 {"ok":true}`.
- Produces: Railway healthcheck `/healthz`, temporary autodeploy pause during merge, then GitHub autodeploy with Wait for CI.

- [ ] **Step 1: Record the current service configuration**

Run:

```bash
railway status --json > /tmp/osh-railway-before.json
railway deployment list --service gra-commu-vocab-test --environment production --json > /tmp/osh-deployments-before.json
```

Verify the service ID is `592009e6-2f6f-4a9d-bd57-bda47f2c2f38`, environment is `production`, domain is unchanged, and volume mount is `/data`.

- [ ] **Step 2: Persist the healthcheck in the Railway service setting**

Run:

```bash
railway environment edit --environment production \
  --service-config gra-commu-vocab-test deploy.healthcheckPath /healthz \
  --message "Configure production health check path"
railway environment edit --environment production \
  --service-config gra-commu-vocab-test deploy.healthcheckTimeout 30 \
  --message "Configure production health check"
```

Immediately run `railway status --json` and verify the applied service configuration reports `/healthz` and timeout `30`. If either command fails, restore that exact field to the value recorded in `/tmp/osh-railway-before.json` before proceeding. Do not change variables, volume, domain, or region.

- [ ] **Step 3: Disable GitHub autodeploy before merging**

In Railway service settings, disable GitHub autodeploy for `main`. Reload the settings page and verify the control remains off; do not make a test push. This prevents the migration commit from bypassing the not-yet-enabled Wait for CI setting.

- [ ] **Step 4: Merge the pull request and verify main CI**

Run:

```bash
gh pr merge --merge --delete-branch
MAIN_RUN_ID="$(gh run list --workflow deploy-check --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$MAIN_RUN_ID"
gh run watch "$MAIN_RUN_ID" --exit-status
```

Expected: the `main` workflow succeeds while Railway autodeploy remains disabled.

- [ ] **Step 5: Enable Railway Wait for CI, then re-enable autodeploy**

In Railway service settings:

1. enable `Wait for CI`;
2. confirm the trigger branch is `main`;
3. re-enable GitHub autodeploy.

Do not enable autodeploy before Wait for CI is visibly on.

- [ ] **Step 6: Bootstrap the first deployment from the GitHub source**

Use Railway's `Deploy Latest Commit` action or the source-only CLI equivalent:

```bash
railway redeploy --service gra-commu-vocab-test --environment production --from-source --yes
```

This command must pull the connected GitHub source. Do not use `railway up`.

- [ ] **Step 7: Verify deployment provenance and healthcheck**

Run:

```bash
git fetch origin main
git rev-parse origin/main
railway deployment list --service gra-commu-vocab-test --environment production --json
curl -fsS https://gra-commu-vocab-test-production-77e7.up.railway.app/healthz
```

Expected:

- latest deployment status is `SUCCESS`;
- latest `meta.commitHash` equals `git rev-parse origin/main`;
- latest `serviceManifest.deploy.healthcheckPath` is `/healthz`;
- curl returns `{"ok":true}`.

If the source deployment fails, keep autodeploy disabled, restore only the Railway settings changed in Steps 2 and 5 to the values recorded in `/tmp/osh-railway-before.json`, and leave the last healthy deployment serving traffic while the failure is diagnosed.

---

### Task 7: Verify production behavior and remove the CLI footgun

**Files:**
- No application changes expected.
- Local Railway project link is removed only after production verification.

**Interfaces:**
- Consumes: successful GitHub-provenance deployment from Task 6.
- Produces: verified production UI and a local directory that cannot directly run `railway up` without an explicit relink.

- [ ] **Step 1: Verify the production home visually**

At 2090×1400 confirm the reference layout and exact six course-description strings. At 390×844 confirm one-column order and evaluate `scrollWidth === clientWidth`.

Also evaluate the loaded illustration:

```js
({
  complete: document.querySelector('.home-illustration img').complete,
  naturalWidth: document.querySelector('.home-illustration img').naturalWidth,
  naturalHeight: document.querySelector('.home-illustration img').naturalHeight,
})
```

Expected: `complete === true`, `naturalWidth === 898`, and `naturalHeight === 518`.

- [ ] **Step 2: Verify production routes**

Check:

```bash
curl -fsS https://gra-commu-vocab-test-production-77e7.up.railway.app/ | grep '日常から仕事まで、使える英語を。'
curl -fsS https://gra-commu-vocab-test-production-77e7.up.railway.app/quiz.html | grep 'join-course-label'
curl -fsS https://gra-commu-vocab-test-production-77e7.up.railway.app/healthz
```

In the browser, activate the join CTA and one course row and verify they open `/quiz.html?mode=join` and `/quiz.html?mode=create` respectively.

- [ ] **Step 3: Verify an actual room still shows its course above the name field**

Create one temporary Clacel room through the production Socket.IO endpoint, open both the new `?room=...&cat=clacel` and legacy `?room=...` join URLs, and verify `Clacelコース` is visible above `名前`. Disconnect the temporary host afterward.

- [ ] **Step 4: Unlink this local directory from production Railway**

Run:

```bash
railway unlink
railway status
```

Expected: unlink succeeds, and `railway status` reports that the directory is not linked. Future read-only or administrative Railway work must use explicit project/service arguments or an intentional temporary relink; normal deployment remains GitHub-only.

- [ ] **Step 5: Run the final repository audit**

Run:

```bash
git status --short
git log --oneline --decorate -8
gh run list --workflow deploy-check --branch main --limit 3
```

Confirm no unrelated user files were committed, deleted, moved, or ignored. Record the final Git commit SHA, GitHub Actions run, Railway deployment ID, and production URL in the completion report.
