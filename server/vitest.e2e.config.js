/**
 * vitest.e2e.config.js
 *
 * Owns the e2e suite: real HTTP against the real Supertest-mounted app, over the real
 * `ticket_booking_test` Postgres database (docs/PROJECT_PROMPT.md's own rule -- "never mock the
 * pool: a mock has no row locks, so a mocked race test proves nothing," CLAUDE.md).
 *
 * Does NOT own: tests/unit/** (vitest.unit.config.js).
 *
 * Invariant: `fileParallelism: false`. Every e2e test file shares the SAME physical database and
 * calls truncateAllTables() between tests -- two test files running concurrently would truncate
 * out from under each other mid-test, and the concurrency suite specifically needs to be the only
 * thing touching its own show_seats rows while its races run, or a stray row from an unrelated
 * file could change how many seats a scenario finds available. Tests WITHIN one file already run
 * sequentially by default; this just extends that guarantee across files too.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.js'],
    environment: 'node',
    // WHY setupFiles here specifically, not a plain import at the top of every test file: Vitest
    // runs every setupFiles entry to completion BEFORE loading the test file itself, which is what
    // lets testEnv.js's DATABASE_URL rewrite land before any test-file import reaches pool.js. See
    // tests/setup/testEnv.js's own header for the full reasoning.
    setupFiles: ['./tests/setup/testEnv.js'],
    fileParallelism: false,
    // WHY longer than Vitest's 5s default: a 50-parallel-hold race genuinely takes a few real
    // seconds against a real database -- row-lock waits under contention are the whole point, not
    // a bug to optimise away.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
