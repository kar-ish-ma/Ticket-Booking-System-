---
name: batch
description: Run several BUILD_LOG tasks back-to-back without stopping for approval between them. Use for config and CRUD phases (0, 1, 2, 7, 8). Never use for phases 3, 4 or 5.
argument-hint: [task range, e.g. "P0-2 to P0-7"]
---

Run the tasks in `$ARGUMENTS` back-to-back. Do not stop between them.

REFUSE and fall back to /next-task if the range includes any task from
phase 3, 4 or 5. Those are the scored mechanisms and get individual
plans and approvals.

For each task in order:
- Implement it. Do not ask permission mid-range.
- Skip the "state your plan and wait" step entirely.
- Run tests only if the task produced testable code. Config tasks do not
  need a test run.

At the very end of the whole range, once:
- Update docs/BUILD_LOG.md (all statuses, files touched, verified by)
  and docs/FILE_MANIFEST.md.
- Run `npm run lint` then `npm test`.
- ONE commit for the whole batch, listing every task ID in the body.
  Subject line: `feat(phase-N): <summary> [P0-2..P0-7]`
- Push. Report the hash.
- Summarise in under 150 words: what got built, anything you decided
  that belongs in the Decisions Ledger, and anything you'd flag.

If you hit something genuinely ambiguous or contradictory, stop at that
task and ask. Do not guess on a design question to preserve speed.
EOF