# Quiz Persistence and Repository Split Design

## Goal

Keep active vocabulary-test rooms recoverable until the organizer explicitly ends them, fit the desktop home into one viewport, and separate the deployable application from the large course-production tree without changing the public Railway URL.

## Room lifecycle

- Persist quiz-room state atomically at `/data/quiz-rooms.json` on Railway.
- Use `QUIZ_ROOM_STATE_FILE` to point integration tests at an isolated temporary file.
- Save room creation, joins, quiz start, submissions, results, replay, participant exit, and organizer exit.
- Restore lobby, playing, and finished rooms at process startup. Recreate the remaining quiz timeout from `endsAt`.
- A socket disconnect never deletes a room or player. Reloading, reopening the tab, a deploy, or a Railway restart must preserve the room.
- A participant's explicit exit removes only that participant.
- An organizer's explicit exit closes and deletes the room and notifies participants.
- Store client recovery credentials in `localStorage`; clear them on explicit exit, rejected recovery, or room closure.
- Never include session tokens in public room updates, URLs, or logs.

## Home layout

- Preserve the title, participant CTA, date/Day card, illustration, all three course descriptions, and operator link.
- At a 1440 by 800 browser window, the rendered document must have no horizontal or vertical overflow and the illustration and operator link must be visible.
- Mobile remains a readable single-column scrolling page.

## Repository separation

- Create public repository `xingaiyuyao-commits/gra-commu-vocab-app` from the reviewed application snapshot, excluding `osh-vocab-test`, obsolete deployment trigger files, and patch artifacts.
- Create private repository `xingaiyuyao-commits/osh-vocab-content` from the tracked `osh-vocab-test` subtree history.
- Preserve all untracked local course files in the existing workspace. Do not delete or publish them.
- Connect the existing Railway service to `gra-commu-vocab-app` branch `main`, retaining the current project, service, domain, variables, and `/data` volume.
- After production verification, archive the old `gra-commu-vocab-test` GitHub repository. It remains a reversible history backup.

## Protection and deployment

- Require the `test` status check and pull requests on the new app repository's `main` branch.
- Block force pushes and branch deletion. Require zero external approvals because this is a single-maintainer repository.
- Keep Railway Wait for CI enabled and deploy only GitHub `main`; never use `railway up`.
- Verify the deployed commit SHA, `/healthz`, desktop viewport, participant entry, restart recovery, and explicit room deletion before archiving the old repository.

## Cleanup

- Remove `REDEPLOY.md`, `url-only-join.patch`, `url-only-join.diff`, and `patch-apply-url-only.py` from the new app repository.
- Replace the historical `railway up` instruction in course documentation with a superseded notice pointing to the canonical deployment document.
- Remove the completed detached worktree only after its branch is safely pushed and merged.

## Rollback

- Before switching Railway, record its current source repository, branch, service ID, environment ID, deployment ID, and commit SHA.
- If the new-source deployment or behavioral verification fails, reconnect the service to `xingaiyuyao-commits/gra-commu-vocab-test` branch `main` and redeploy from source.
- Do not delete the existing Railway volume or old GitHub repository during migration.
