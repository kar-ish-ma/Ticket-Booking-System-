---
name: prove-race
description: Write or audit a concurrency test that proves a race is actually handled. Use when adding or reviewing any code path where two requests could contend for the same seat, hold, booking or waitlist offer.
argument-hint: [what is being contended, e.g. "one seat, 50 holders"]
---

Write a test that proves the race described in `$ARGUMENTS` is handled. Rules:

- Use the **real local `ticketflow_test` database**. A mocked pool has no row locks, so a mocked
  race test proves nothing. If you find yourself reaching for `vi.mock` on the pg pool, stop.
- Stop the dev server before running these — the machine has 4 GB and will thrash otherwise.
- Fire the contending requests with `Promise.allSettled` on a **single** shared setup, so they
  genuinely overlap. Sequential requests are not a race.
- Assert **exact** counts, never "at least" or "greater than". `expect(successes).toBe(1)` — not
  `toBeGreaterThan(0)`.
- Assert the database end state as well as the HTTP responses. One 201 with two `HELD` rows is
  still a failure.
- Assert the losers get the correct error code from `packages/shared/src/constants/errors.ts`,
  not just a non-2xx.
- For multi-seat contention, assert **atomicity**: the loser must hold zero seats, not some.
- Run the test 3× before declaring it green. A race test that passes once proves nothing.

Then do the falsification check: temporarily break the mechanism the test is supposed to be
guarding (comment out the predicate, widen the transaction, remove the guard), re-run, and confirm
the test **fails**. Restore the code. Report both results. If the test still passed, the test is
wrong — rewrite it.