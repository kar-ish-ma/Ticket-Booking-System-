/**
 * migrate.js
 *
 * Owns invoking node-pg-migrate programmatically, as a thin CLI wrapper: `node
 * src/db/migrate.js up` / `... down` / `... reset`.
 *
 * WHY this exists instead of calling the node-pg-migrate CLI directly (which is what
 * PROJECT_PROMPT.md's own db:migrate command implies): the CLI's --envPath flag silently does
 * nothing without the `dotenv` package installed -- it wraps the load in `await
 * tryImport("dotenv")` and just skips it if that import fails, with no warning at all. This
 * project deliberately doesn't depend on `dotenv` (D-18: Node's built-in process.loadEnvFile()
 * covers the same job). Rather than add a dependency back just to satisfy the CLI's assumption,
 * this wrapper reuses the exact same validated `env` this whole server already boots from, and
 * calls node-pg-migrate's programmatic `runner()` API directly. See Decisions Ledger D-22.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

import { env } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Runs one node-pg-migrate step and logs what it did.
 *
 * @param {'up' | 'down'} direction
 * @param {number | undefined} count - number of migrations to run; undefined means "all pending"
 * @returns {Promise<import('node-pg-migrate').RunMigration[]>} the migrations that ran, in order
 */
async function runMigration(direction, count) {
  const results = await runner({
    databaseUrl: env.DATABASE_URL,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction,
    count,
  });

  for (const migration of results) {
    console.log(`${direction === 'up' ? 'Applied' : 'Reverted'}: ${migration.name}`);
  }
  if (results.length === 0) {
    console.log(`No migrations to ${direction === 'up' ? 'apply' : 'revert'}.`);
  }

  return results;
}

const mode = process.argv[2];

if (mode === 'up') {
  // "all pending" -- npm run db:migrate should never leave a migration half-applied.
  await runMigration('up', undefined);
} else if (mode === 'down') {
  // One step -- undo the last thing, which is what a developer reaching for db:migrate:down
  // almost always wants, not the whole history.
  await runMigration('down', 1);
} else if (mode === 'reset') {
  // WHY a loop of single-step downs instead of one call with a large count:
  // node-pg-migrate's `count` option has no documented "all" sentinel, and guessing a number
  // "big enough" is exactly the kind of magic-number fragility this project avoids elsewhere.
  // Looping single-step downs until nothing is left is slower but can't under- or over-shoot.
  //
  // WHY this exists at all (docs/TESTING.md): reversibility only stays provably true as
  // migrations accumulate if something actually re-runs every down() on every change, not just
  // the down() for whatever migration was added most recently.
  let reverted;
  do {
    reverted = await runMigration('down', 1);
  } while (reverted.length > 0);
  await runMigration('up', undefined);
} else {
  console.error('Usage: node src/db/migrate.js <up|down|reset>');
  process.exit(1);
}

process.exit(0);
