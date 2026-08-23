---
name: ship
description: Commit and push the current work safely. Use at the end of a task, at the halfway point of a long task, or any time the user says to save or push progress.
---

Get the current work committed and pushed. Do not skip steps.

1. `git status` and `git diff --stat`. Show me what's about to be committed.
2. Check for anything that must never be committed: `.env`, real credentials, `node_modules`, `dist`, database dumps, `*.pem`. Also check `.gitignore` is not silently excluding docs or `CLAUDE.md`. If you find a problem, stop and tell me first.
3. Run `npm run lint` then `npm test`. If either fails:
   - If the work is complete but broken, fix it before committing.
   - If the work is mid-task and known-incomplete, commit with a `wip:` prefix and say so explicitly. Never push red work under a `feat:` message.
4. Confirm `docs/BUILD_LOG.md` and `docs/FILE_MANIFEST.md` reflect this change. Update them now if not — same commit as the code, never a follow-up.
5. Stage, commit, push. Conventional Commits with the task ID: `feat(waitlist): HMAC offer tokens [P5-4]`. Body: 2–4 bullets on what changed and why.
6. Report the commit hash, branch, and file count. If the push failed for any reason, say so as the first line and stop. Do not keep working on top of unpushed commits.

Never `git push --force` to `main`. Never amend an already-pushed commit.
