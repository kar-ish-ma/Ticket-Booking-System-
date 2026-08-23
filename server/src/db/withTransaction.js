/**
 * withTransaction.js
 *
 * Owns the one place BEGIN/COMMIT/ROLLBACK happens in this codebase. Every function that runs
 * more than one SQL statement as a unit -- which, in this project, means almost every write --
 * goes through here instead of hand-rolling its own transaction block.
 *
 * Does NOT own: the pool itself (pool.js) or any actual SQL (*.queries.js files).
 *
 * Invariant, and the single easiest way to break correctness with `pg`: every query function
 * called from inside fn() MUST take the `client` this passes in and run its query through
 * `client.query(...)`, never through `pool.query(...)`. Calling `pool.query` inside a
 * transaction checks out a DIFFERENT connection from the pool -- one that never saw the BEGIN --
 * so that query silently runs outside the transaction entirely. No error, no warning: it just
 * commits (or doesn't) independently of everything else in the block. Comment this at the top of
 * every `*.queries.js` file, not just here.
 */

import { pool } from './pool.js';

// WHY a named, commented constant instead of the literal '5s' inline:
// docs/PROJECT_PROMPT.md §6.3 gives '5s' as the reference value verbatim -- it isn't in the
// §12 env var list, so it isn't meant to be per-deployment tunable the way TTLs are. It's a
// safety boundary (a runaway transaction holding a row lock is worse than a query that fails
// fast), not a business parameter. Naming it here at least makes it greppable and explained,
// even though it isn't env-configurable.
const STATEMENT_TIMEOUT = '5s';

/**
 * Runs `fn` inside a single BEGIN/COMMIT/ROLLBACK transaction on one checked-out client, with a
 * statement timeout applied for the lifetime of that transaction only (SET LOCAL, not SET --
 * it's reset automatically at COMMIT/ROLLBACK and never leaks onto the next thing this
 * connection does once it's back in the pool).
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn - receives the transaction's
 *   client. Every query inside fn must be run through THIS client, never through `pool` directly
 *   -- see the file header.
 * @returns {Promise<T>} whatever fn resolves to
 * @throws {Error} whatever fn throws, after the transaction has been rolled back. The caller
 *   never has to roll back manually; by the time this rejects, the DB is already clean.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // WHY ROLLBACK is safe to call even if the error happened before BEGIN fully applied, or if
    // the connection is already in a failed-transaction state: Postgres treats ROLLBACK on a
    // connection with no open transaction (or one already aborted) as a no-op, never an error
    // that could mask the original one being re-thrown below.
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // ALWAYS -- not just on the happy path. A client that never gets released back to the pool
    // (because a code path returned or threw before this ran) permanently shrinks the pool by
    // one connection. Do this enough times and the pool exhausts itself even though nothing is
    // technically "wrong" with any single request.
    client.release();
  }
}
