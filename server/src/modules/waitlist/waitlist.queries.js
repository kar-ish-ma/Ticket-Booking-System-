/**
 * waitlist.queries.js
 *
 * Owns the raw SQL for waitlist_entries: joining the FIFO queue, and the position lookup that
 * derives "you are #7 of 23" from the SAME table that holds the queue itself (docs/PROJECT_PROMPT.md
 * §7.1), so the two can never disagree the way a mirrored Redis sorted set could.
 *
 * Does NOT own: request validation (shared/schemas/waitlist.schema.js), the effective-availability
 * check that gates joining (reuses seatmap.queries.js#EFFECTIVE_STATE_CASE, the single source of
 * truth for "is this seat really available right now" -- see that file's header), or offer
 * lifecycle SQL (waitlist_offers -- offers.queries.js, later in Phase 5).
 *
 * Invariant: every function here takes a `client`. Never call `pool.query` inside a
 * transaction — see withTransaction.js's header for why that silently breaks correctness.
 */

import { EFFECTIVE_STATE_CASE } from '../seatmap/seatmap.queries.js';

function mapEntryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    showId: row.show_id,
    categoryId: row.category_id,
    userId: row.user_id,
    quantity: row.quantity,
    status: row.status,
    enqueuedAt: row.enqueued_at,
  };
}

/**
 * How many show_seats rows in this category are AVAILABLE right now -- effective state, not raw
 * stored state, via the same CASE expression the seat map itself reads (Layer 1 of the TTL
 * design). A category with a nonzero count here means joining the waitlist is premature: there's
 * a seat to just hold and book instead.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} showId
 * @param {string} categoryId
 * @returns {Promise<number>}
 */
export async function countEffectiveAvailableSeats(client, showId, categoryId) {
  const result = await client.query(
    `SELECT count(*)::int AS n
       FROM show_seats ss
      WHERE ss.show_id = $1 AND ss.category_id = $2 AND ${EFFECTIVE_STATE_CASE} = 'AVAILABLE'`,
    [showId, categoryId]
  );
  return result.rows[0].n;
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ showId: string, categoryId: string, userId: string, quantity: number }} params
 * @returns {Promise<object>} the created entry, camelCased, status WAITING
 * @throws {Error} with `.code === '23505'` if this user already has an entry for this
 *   (show, category) -- caught and translated to AlreadyWaitlistedError in waitlist.service.js
 */
export async function insertWaitlistEntry(client, { showId, categoryId, userId, quantity }) {
  const result = await client.query(
    `INSERT INTO waitlist_entries (show_id, category_id, user_id, quantity)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [showId, categoryId, userId, quantity]
  );
  return mapEntryRow(result.rows[0]);
}

/**
 * The literal docs/PROJECT_PROMPT.md §7.1 query: this user's 1-indexed position among WAITING
 * entries for this (show, category), ordered FIFO by enqueued_at, plus how many are waiting in
 * total. ROW_NUMBER() is computed over the filtered WAITING set, not a stored counter -- a
 * cancelled or converted entry in the middle of the queue simply isn't in the window function's
 * input, so everyone behind it renumbers for free on the next read. Nothing to keep in sync.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ showId: string, categoryId: string, userId: string }} params
 * @returns {Promise<{ position: number, total: number } | null>} null if this user has no WAITING
 *   entry for this (show, category) -- never in the queue, or already offered/converted/expired
 */
export async function findQueuePosition(client, { showId, categoryId, userId }) {
  const result = await client.query(
    `SELECT position, total FROM (
       SELECT user_id,
              (ROW_NUMBER() OVER (ORDER BY enqueued_at))::int AS position,
              (COUNT(*) OVER ())::int                        AS total
         FROM waitlist_entries
        WHERE show_id = $1 AND category_id = $2 AND status = 'WAITING'
     ) q WHERE user_id = $3`,
    [showId, categoryId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { position: row.position, total: row.total };
}

/**
 * This user's waitlist_entries row for this (show, category), in whatever status it's actually
 * in -- WAITING, OFFERED, CONVERTED, EXPIRED, or CANCELLED. Deliberately NOT filtered to WAITING
 * (unlike findQueuePosition()'s subquery): GET /waitlist/me needs to report "you were offered a
 * seat" or "your wait ended" just as much as a live position, and the UNIQUE constraint means
 * there is at most one row to find regardless of status.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ showId: string, categoryId: string, userId: string }} params
 * @returns {Promise<object | null>} null if this user has never joined this (show, category)
 */
export async function findEntryForUser(client, { showId, categoryId, userId }) {
  const result = await client.query(
    `SELECT * FROM waitlist_entries WHERE show_id = $1 AND category_id = $2 AND user_id = $3`,
    [showId, categoryId, userId]
  );
  return mapEntryRow(result.rows[0]);
}
