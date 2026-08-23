---
name: close-phase
description: Audit a completed phase against its exit criteria before moving on. Use after the last task in a phase is marked done, and before starting the next phase.
argument-hint: [phase number, e.g. 3]
---

Audit phase `$ARGUMENTS` before we move on. Report as a punch list, not prose.

1. Re-read the phase's exit criteria in `docs/BUILD_LOG.md`. For each, state whether it is met and cite the specific test or file demonstrating it. "Looks done" is not evidence.
2. Cross-check every ✅ row: does the named file exist, does the named test exist and pass? Flag any row marked done without an artefact.
3. Check `docs/FILE_MANIFEST.md` against the actual tree. List files present but undocumented, and documented but absent.
4. Re-read the Invariants section of `CLAUDE.md` and check this phase's code against each. Name any violation with a file and line.
5. Run the full test suite and paste the summary. Report coverage for the modules this phase touched.
6. Check for `TODO`, `FIXME`, `@ts-ignore`, and commented-out code in the phase's files.
7. Confirm the Decisions Ledger has an entry for every non-obvious choice made in this phase.

End with a verdict: **CLEAR** to proceed, or a numbered list of what must be fixed first. Do not start the next phase.
