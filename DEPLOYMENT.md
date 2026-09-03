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

Railway's existing `/data` volume contains `/data/quiz-rooms.json`. Version 2 of this file holds both active quiz rooms and `resultHistory`; do not replace the volume or copy this file into the repository.

Before deleting history, changing the volume, or performing a rollback that may affect the saved schema, take an access-controlled backup of `/data/quiz-rooms.json` using the Railway volume backup/export procedure. Confirm the backup is readable JSON with `version: 2`, and keep it in the approved private storage location.

## Delete a results-history record

1. Back up `/data/quiz-rooms.json`.
2. Log in at the results-history URL above.
3. Select the target month and confirm the exact date and course before choosing delete.
4. Confirm the row disappears, `/healthz` still returns 200, and unrelated dates/courses remain visible.

Deletion removes only the selected date/course history record. Treat it as irreversible unless the pre-deletion backup is restored.

## Prohibited normal operation

Do not use `railway up` for production. It uploads the local working tree and can include untracked files that do not exist in GitHub.

## Rollback

Use `git revert <bad-commit>` and push the revert. Do not deploy an older local folder with `railway up`.

After the revert is merged, confirm Railway reports SUCCESS for that exact merge SHA. Then verify `/healthz` returns 200, the existing `/data` volume is still mounted, `RESULTS_ADMIN_PASSWORD` is still configured, results-history login succeeds, existing history remains visible, and the normal host/participant flow still reaches result reveal. If persistence or history checks fail, stop and restore from the protected backup before creating or deleting more records.
