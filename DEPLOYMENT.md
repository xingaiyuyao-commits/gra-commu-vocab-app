# Production deployment

Production URL: https://gra-commu-vocab-test-production-77e7.up.railway.app/

## Normal path

1. Run `npm test`, `npm run test:deploy`, `npm run test:load`, and `npm audit --omit=dev`.
2. Commit only the intended files.
3. Push to GitHub `main` through the reviewed branch/PR.
4. Confirm GitHub check `deploy-check / test` succeeds.
5. Confirm Railway deploys the same Git commit SHA and reports SUCCESS.
6. Check `/healthz`, the production HTML, and the visible user flow.

## Results history password

`RESULTS_ADMIN_PASSWORD` is required for the private results-history screen. Do not put its value in this file, Git, command output, screenshots, or support messages.

1. Generate a strong unique password and store it in the approved password manager.
2. In the existing Railway service, set `RESULTS_ADMIN_PASSWORD` as a service variable without exposing its value in logs.
3. Let Railway redeploy, then confirm `/healthz` returns 200.
4. Open `https://gra-commu-vocab-test-production-77e7.up.railway.app/results-history.html` and confirm the new password can log in.
5. Confirm an old or incorrect password is rejected and no password appears in the response or the persisted state file.

To rotate the password, repeat these steps with a newly generated value. Rotation invalidates existing results-history sessions, so log in again and confirm the old value no longer works. If the variable is absent, all `/api/results-history` endpoints intentionally return 503.

## Persistent data and backups

Railway's existing `/data` volume contains `/data/quiz-rooms.json`. Version 2 of this file holds both active quiz rooms and `resultHistory`; do not replace the volume or copy this file into the repository. Each completed date/course record now includes all-question aggregate statistics (`questionStats`) used to prioritize review-day questions. It does not store participants' raw answer text.

Before deleting history, changing the volume, or performing a rollback that may affect the saved schema, take an access-controlled backup of `/data/quiz-rooms.json` using the Railway volume backup/export procedure. Confirm the backup is readable JSON with `version: 2`, and keep it in the approved private storage location.

## Delete a results-history record

1. Back up `/data/quiz-rooms.json`.
2. Log in at the results-history URL above.
3. Select the target month and confirm the exact date and course before choosing delete.
4. Confirm the row disappears, `/healthz` still returns 200, and unrelated dates/courses remain visible.

Deletion removes only the selected date/course history record. Treat it as irreversible unless the pre-deletion backup is restored.

## Prohibited normal operation

Do not use `railway up` for production. It uploads the local working tree and can include untracked files that do not exist in GitHub.

The browser word-list editor and `ADMIN_PASSWORD` are obsolete. Do not recreate or configure them. Vocabulary updates must be imported from the approved PDFs with `scripts/import-september-pdfs.py`, reviewed through the generated files in `data/wordtests`, tested, committed, and deployed through GitHub. `RESULTS_ADMIN_PASSWORD` remains required and is unrelated to vocabulary editing.

## September content and review-day checks

1. Run `node --test tests/september-wordtests.test.js tests/quiz-review-selection.test.js tests/admin-words-removed.test.js`.
2. Confirm Clacel has 420 imported questions, TOEIC 440, and IELTS 440; confirm Day 26 and later are not selectable.
3. Create a normal room and confirm the selected Day uses the imported PDF questions and a 5-minute limit.
4. Create Day 7, Day 14, or Day 21 and confirm it starts with exactly 50 unique questions, uses 8 or 9 questions from each preceding study day, and has a 12-minute-30-second limit.
5. Restart the service while the review room is active and confirm the same question order and deadline are restored from `/data/quiz-rooms.json`.
6. Reveal results and confirm the daily record stores 50 `questionStats` entries, then confirm the private results-history page still shows participant and perfect-score information.
7. Confirm `/admin-words.html` and `/api/admin/wordtests/clacel` both return 404.

## Rollback

Only deploy rollback code that remains compatible with the version-2 `/data/quiz-rooms.json` schema. Prefer a forward fix. If a code revert is necessary, build and review a revert that retains the version-2 persistence reader/writer and result-history adapter.

1. Stop the Railway service before taking the rollback backup so no process can write while the file is copied.
2. Back up `/data/quiz-rooms.json` to approved private storage and verify that the backup is readable JSON with `version: 2`.
3. Confirm the proposed rollback artifact reads and writes version 2 without discarding `resultHistory`. Never start a version-1 writer against the mounted version-2 file, and never revert away the version-2 adapter while that file is mounted.
4. Deploy the reviewed schema-compatible forward fix or code revert through GitHub. Do not deploy an older local folder with `railway up`.
5. Start the service only after the compatible artifact is deployed. Confirm Railway reports SUCCESS for that exact merge SHA, then verify `/healthz` returns 200, the existing `/data` volume is still mounted, `RESULTS_ADMIN_PASSWORD` is still configured, results-history login succeeds, existing history remains visible, and the normal host/participant flow still reaches result reveal.

If no schema-compatible artifact is ready, keep the service stopped and prepare a forward fix; do not test an older writer on the live volume. If persistence or history checks fail after startup, stop the service again before restoring the protected version-2 backup or creating/deleting any records.
