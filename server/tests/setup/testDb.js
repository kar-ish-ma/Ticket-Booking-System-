/**
 * testDb.js
 *
 * Owns the e2e suite's database lifecycle: running every migration once per test file, emptying
 * every application table between tests, and closing the pool when a file's suite finishes.
 *
 * Does NOT own: pointing the process at the test database in the first place. That's
 * tests/setup/testEnv.js, and it MUST already have run -- as a Vitest `setupFiles` entry, before
 * this file's own `import { pool } from '../../src/db/pool.js'` executes -- see that file's header
 * for exactly why the two are split apart instead of being one file.
 *
 * Invariant: truncateAllTables() and migrateTestDb() both refuse to run against any database whose
 * own `current_database()` doesn't end in `_test`. See assertTestDatabase()'s comment for why this
 * is a second, DB-level check rather than trusting testEnv.js's string derivation alone.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

import { pool } from '../../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '../../src/db/migrations');

// Every application table a test could put a row in, listed explicitly rather than discovered via
// information_schema -- a table added later and forgotten here fails LOUDLY (leftover rows
// breaking an unrelated test downstream) instead of silently being skipped from the sweep.
// TRUNCATE ... CASCADE handles FK ordering itself, so this list doesn't need to be FK-correct,
// just complete.
const APPLICATION_TABLES = [
  'ticket_scans',
  'audit_log',
  'outbox_events',
  'job_queue',
  'waitlist_offers',
  'waitlist_entries',
  'booking_seats',
  'payments',
  'bookings',
  'show_seats',
  'seat_holds',
  'show_prices',
  'shows',
  'events',
  'seats',
  'seat_categories',
  'venues',
  'refresh_tokens',
  'users',
];

/**
 * WHY this exists as a real query against Postgres itself, not just a re-check of testEnv.js's
 * string derivation: testEnv.js decides what DATABASE_URL SHOULD be, but a mistake anywhere
 * upstream of that -- a stale env var already set before testEnv.js runs, a future config change
 * that skips it, a test file importing pool.js before setupFiles has run -- could still hand this
 * module a pool connected to the real `ticket_booking`. truncateAllTables() is the single most
 * destructive statement in the whole test suite; asking Postgres itself what database this
 * connection is ACTUALLY in, and refusing outright if the answer doesn't end in `_test`, is the
 * last line of defence between a test run and wiped production-shaped data.
 *
 * @returns {Promise<void>}
 * @throws {Error} if the pool is not connected to a database whose name ends in `_test`
 */
async function assertTestDatabase() {
  const { rows } = await pool.query('SELECT current_database() AS name');
  const name = rows[0].name;
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run against database "${name}" -- it does not end in "_test". This guard ` +
        'exists so a misconfigured DATABASE_URL can never truncate real data.'
    );
  }
}

/**
 * Applies every pending migration against the test database. Safe to call at the start of every
 * e2e test file, even ones that run after others already did -- node-pg-migrate's own
 * `pgmigrations` tracking table makes re-running `up` a no-op for anything already applied.
 *
 * WHY this doesn't reuse server/src/db/migrate.js: that file is a `node src/db/migrate.js up` CLI
 * entry point -- its top-level code reads `process.argv[2]` and calls `process.exit(0)`
 * unconditionally at the bottom of the module. Importing it from a test process would exit the
 * Vitest worker the instant it loaded. This calls node-pg-migrate's own `runner()` directly
 * instead, the same way that file does, without the CLI-only parts.
 *
 * @returns {Promise<void>}
 */
export async function migrateTestDb() {
  await assertTestDatabase();
  await runner({
    databaseUrl: process.env.DATABASE_URL,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
  });
}

/**
 * Empties every application table so each test starts from a blank slate. Called between tests
 * (typically `afterEach`), not just once per file -- the concurrency suite in particular must
 * never let one scenario's leftover rows change how many seats the next scenario sees available.
 *
 * @returns {Promise<void>}
 */
export async function truncateAllTables() {
  await assertTestDatabase();
  await pool.query(`TRUNCATE TABLE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Closes this test file's pool. Vitest's default per-file module isolation means every e2e test
 * file gets its own fresh `pool.js` instance (and therefore its own real TCP connections) -- call
 * this in that file's own `afterAll` so those connections don't linger past the file's own suite.
 *
 * @returns {Promise<void>}
 */
export async function closeTestDb() {
  await pool.end();
}
