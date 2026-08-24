/**
 * vitest.unit.config.js
 *
 * Owns the unit suite: pure-logic tests with no database and no HTTP, safe to run fully
 * parallel. Split from vitest.e2e.config.js (docs/BUILD_LOG.md P3-9) because the two suites have
 * opposite concurrency needs -- this one has no shared mutable state to race over; the e2e suite
 * shares one real Postgres database across every test and file, and racing test FILES against
 * each other there would corrupt the very tests that are supposed to prove races are handled
 * correctly.
 *
 * Does NOT own: anything under tests/e2e/** (vitest.e2e.config.js) or pointing at a database --
 * this config never loads tests/setup/testEnv.js, on purpose. A unit test that somehow needed a
 * DB connection would be in the wrong file.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
});
