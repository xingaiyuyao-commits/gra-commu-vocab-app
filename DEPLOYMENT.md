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
