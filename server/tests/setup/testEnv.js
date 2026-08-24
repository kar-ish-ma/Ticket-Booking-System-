/**
 * testEnv.js
 *
 * Owns pointing the process at the TEST database before anything else -- most importantly,
 * before server/src/db/pool.js (via server/src/config/env.js) ever reads process.env.DATABASE_URL
 * to build its `new Pool(...)`. Registered as a Vitest `setupFiles` entry (vitest.e2e.config.js),
 * never imported directly by a test file.
 *
 * Does NOT own: running migrations or truncating tables (testDb.js) -- deliberately split into
 * its own file instead of folded into testDb.js. ESM import statements execute top-to-bottom, in
 * order, as each is reached -- so within a single file, `import './testEnv.js'; import { pool }
 * from '...pool.js';` would actually be safe on its own. But a Vitest e2e test file's OWN imports
 * (`import { createHold } from '../../src/modules/holds/holds.service.js'`) are what transitively
 * reach pool.js, and those happen when the TEST FILE is loaded -- which, under Vitest's default
 * per-file module isolation, is a separate module-graph load than this setup file's. `setupFiles`
 * is the mechanism that guarantees this file's entire body finishes running BEFORE that happens;
 * nothing about plain ESM import ordering would. Get this wrong and every test silently runs
 * against the DEVELOPMENT database (`ticket_booking`) instead of `ticket_booking_test`.
 *
 * Invariant: this file imports nothing from src/. The moment it imports something that imports
 * config/env.js, THAT module's eager, top-of-file Zod parse runs against whatever
 * process.env.DATABASE_URL happens to be at that instant -- which, before the derivation below has
 * run, is the real one. That would defeat the entire point of this file existing.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = 'test';

// WHY loaded here too, not just left to config/env.js: config/env.js is specifically one of the
// modules this file must run BEFORE (see header). Local dev's DATABASE_URL only exists because
// it's in the repo-root .env -- if nothing loads that file before the derivation below runs, there
// is nothing to derive a test URL FROM. Same guarded existsSync check env.js itself uses (P0-5) --
// missing in CI/production is the expected case there, where real env vars are injected directly.
const envPath = path.resolve(__dirname, '../../../.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error(
    'testEnv.js: DATABASE_URL is not set. Local dev: check the repo-root .env. CI: check ' +
      '.github/workflows/ci.yml\'s env block.'
  );
}

// WHY a regex on the trailing path segment instead of `new URL(rawUrl).pathname`: a password
// containing characters like `@` or `/` round-trips unpredictably through the URL class's
// re-encoding on `.toString()` -- not worth the risk for what is, structurally, just "swap the
// last path segment." This matches "postgresql://...:.../dbname" and "...dbname?sslmode=require"
// alike, capturing the trailing db name and an optional query string separately.
const match = /^(.*\/)([^/?]+)(\?.*)?$/.exec(rawUrl);
if (!match) {
  throw new Error(`testEnv.js: could not find a database name in DATABASE_URL: ${rawUrl}`);
}
const [, prefix, dbName, query = ''] = match;

// WHY check before appending, rather than always appending "_test":
// CI's Postgres service container (.github/workflows/ci.yml) is already named
// ticket_booking_test -- DATABASE_URL there already ends in _test. Appending unconditionally would
// derive ticket_booking_test_test, a database that doesn't exist, and every e2e test would fail at
// the connection step. Local dev's DATABASE_URL points at the real `ticket_booking` and needs the
// suffix appended to land on `ticket_booking_test` instead. Checking first makes this file correct
// in both environments without an env var to tell it which one it's in.
const testDbName = dbName.endsWith('_test') ? dbName : `${dbName}_test`;

process.env.DATABASE_URL = `${prefix}${testDbName}${query}`;
