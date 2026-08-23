---
name: next-task
description: Start the next unstarted task from BUILD_LOG.md. Use at the beginning of a working session, or after finishing a task, to pick up the next unit of work in order.
---

Do the following, in order:

1. Read `docs/BUILD_LOG.md`. Identify the lowest-numbered task with status ⬜ that is not blocked. If a task is 🟨 in progress, resume that one instead.
2. Read the sections of `docs/PROJECT_PROMPT.md` that this task depends on. For Phase 3, 4 and 5 tasks, read §5, §6 and §7 in full — do not work from memory.
3. Read `docs/FILE_MANIFEST.md` for the files you are about to touch.
4. State your plan in 3–5 bullets: what you'll build, which files, what the test asserts, and any invariant from CLAUDE.md that constrains the design. **Stop and wait for my approval.**
5. On approval: mark the task 🟨, implement it, run the relevant tests, and paste the output.
6. Update `docs/BUILD_LOG.md` (status ✅, files touched, verified by, commit hash) and `docs/FILE_MANIFEST.md` if files were added or removed. Add a Decisions Ledger row if you made a non-obvious call.
7. Run `npm run lint` then `npm test`. Then `git add -A`, commit with the task ID in the message, and **push**. Docs and code go in the same commit. If the push fails, say so loudly and stop.
8. Explain what you built in under 200 words: the shape of the solution, the one non-obvious thing, and what would break if done the naive way. Assume I will defend this design out loud.

Do not start the following task. Stop and report the commit hash.
