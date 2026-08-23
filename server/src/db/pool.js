/**
 * pool.js
 *
 * Owns the single pg.Pool this whole server shares. Every query, everywhere, goes through
 * either pool.query() directly (outside a transaction) or a client checked out from this pool
 * inside withTransaction() -- never a second pool, never a raw new pg.Client() for ordinary
 * queries.
 *
 * Does NOT own: transaction lifecycle (withTransaction.js) or any actual SQL (*.queries.js
 * files, Phase 2 onward).
 *
 * Invariant: max connections stays at PGPOOL_MAX (10 by default). See .env.example and
 * docs/DEPLOYMENT.md's postgresql.conf section for why -- raising it here without also raising
 * Postgres's own max_connections is a way to silently start refusing connections under load.
 */

// WHY `import pg from 'pg'` + destructure, not `import { Pool } from 'pg'`:
// pg ships as CommonJS. Node's CJS/ESM interop can name-export a CJS module's properties, but
// pg's own docs recommend the default-import-then-destructure form specifically because that
// interop has been unreliable across pg versions and bundlers in the past -- this form works
// unconditionally since it never depends on static named-export detection.
import pg from 'pg';

import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PGPOOL_MAX,
});

// WHY this handler exists at all:
// A pooled, idle client can emit its own 'error' event if the underlying connection drops
// (network blip, Postgres restart) -- outside of any query response. Without a listener here,
// that's an uncaught exception on the process, which crashes the whole server over one dropped
// backend connection instead of just failing the query that was using it.
pool.on('error', (err) => {
  // WHY console instead of pino here:
  // This has no request context to log through (it can fire between requests, or with none in
  // flight at all), and no shared logger instance exists yet (P9-3). Same reasoning as
  // index.js's startup line.
  console.error('Unexpected error on an idle pg client:', err);
});
