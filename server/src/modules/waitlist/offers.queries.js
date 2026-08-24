/**
 * offers.queries.js
 *
 * Owns the raw SQL for waitlist_offers, and the show_seats transition into OFFER_RESERVED that
 * creating an offer requires -- the two always change together (a waitlist_offers row with no
 * OFFER_RESERVED seats behind it, or vice versa, is exactly the corrupt state a shared transaction
 * boundary exists to rule out; see offers.service.js#createInitialOffer's own header).
 *
 * Does NOT own: picking WHO gets offered a seat (waitlist.queries.js#claimNextWaitingEntry),
 * generating the token itself (offers.service.js#generateOfferToken, P5-4 -- this file only
 * stores whatever hash it's given), or orchestration across multiple categories
 * (bookings.service.js#cancelBooking).
 *
 * Invariant: every function here takes a `client` that must already be inside a transaction --
 * see withTransaction.js's header for why calling `pool.query` here instead would silently escape
 * it.
 */

function mapOfferRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    waitlistEntryId: row.waitlist_entry_id,
    showSeatIds: row.show_seat_ids,
    tokenHash: row.token_hash,
    status: row.status,
    attemptNo: row.attempt_no,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * The BOOKED -> OFFER_RESERVED half of §7.2's cancellation flow, scoped to one category of one
 * booking so a booking spanning multiple categories can route each one independently (some to a
 * waiting queue, others straight to AVAILABLE -- bookings.service.js#cancelBooking's own loop).
 *
 * WHY both `expires_at` and `reserved_until` are computed here with independent
 * `now() + make_interval(...)` expressions, rather than computing one timestamp in JS and passing
 * it to both this query and insertWaitlistOffer(): Postgres's `now()` returns the START TIME OF
 * THE CURRENT TRANSACTION, not wall-clock-at-statement-execution -- it does not advance between
 * statements in the same transaction. Both this UPDATE and insertWaitlistOffer()'s INSERT run
 * inside the SAME transaction (bookings.service.js#cancelBooking's one withTransaction() call), so
 * two independent `now() + make_interval(secs => $offerTtlSeconds)` expressions are GUARANTEED to
 * evaluate identically -- no timestamp needs to cross the JS/SQL boundary, and "now() always comes
 * from Postgres, never the app clock" (CLAUDE.md) holds for both values, not just one.
 *
 * WHY `reserved_until` uses a DIFFERENT interval than `expires_at`, not the same $offerTtlSeconds
 * (Decisions Ledger D-14): `expires_at` is THIS attempt's deadline; `reserved_until` is the fixed
 * outer bound the WHOLE cascade must finish inside, computed as
 * offerTtlSeconds * maxCascadeAttempts + 60s grace and set ONCE here, on attempt 1. P5-6's cascade
 * will update `expires_at` on every re-offer but must never touch `reserved_until` again -- see
 * that task's own note in docs/PROJECT_PROMPT.md §7.4.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ bookingId: string, categoryId: string, offerTtlSeconds: number, reservedUntilSeconds: number }} params
 * @returns {Promise<Array<{ showSeatId: string, seatId: string }>>} the seats actually
 *   transitioned -- scoped by `WHERE booking_id = $1 AND category_id = $2 AND state = 'BOOKED'`,
 *   so this is naturally idempotent-safe the same way releaseBookedSeatsForCategory() is: a seat
 *   that isn't BOOKED under this booking simply isn't touched
 */
export async function transitionBookedSeatsToOfferReserved(
  client,
  { bookingId, categoryId, offerTtlSeconds, reservedUntilSeconds }
) {
  const result = await client.query(
    `UPDATE show_seats
        SET state = 'OFFER_RESERVED',
            booking_id = NULL,
            expires_at = now() + make_interval(secs => $3),
            reserved_until = now() + make_interval(secs => $4),
            version = version + 1,
            updated_at = now()
      WHERE booking_id = $1 AND category_id = $2 AND state = 'BOOKED'
     RETURNING id, seat_id`,
    [bookingId, categoryId, offerTtlSeconds, reservedUntilSeconds]
  );
  return result.rows.map((row) => ({ showSeatId: row.id, seatId: row.seat_id }));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ id: string, waitlistEntryId: string, showSeatIds: string[], tokenHash: string, attemptNo: number, offerTtlSeconds: number }} params
 *   `id` is supplied by the caller rather than left to the column's own `gen_random_uuid()`
 *   default -- docs/PROJECT_PROMPT.md §7.3's raw token embeds the offer's id
 *   (`${offerId}.${randomBytes}`), so the id has to exist and be known BEFORE this INSERT runs,
 *   not be read back from it afterward. See offers.service.js#generateOfferToken.
 * @returns {Promise<object>} the created offer, camelCased, status PENDING
 * @throws {Error} with `.code === '23505'` on an `id` or `token_hash` collision -- astronomically
 *   unlikely (a `crypto.randomUUID()` id, a 32-random-byte token), not caught specially here; a
 *   real collision would be a bug worth a loud failure, not a silent retry
 */
export async function insertWaitlistOffer(
  client,
  { id, waitlistEntryId, showSeatIds, tokenHash, attemptNo, offerTtlSeconds }
) {
  const result = await client.query(
    `INSERT INTO waitlist_offers (id, waitlist_entry_id, show_seat_ids, token_hash, attempt_no, expires_at)
     VALUES ($1, $2, $3::uuid[], $4, $5, now() + make_interval(secs => $6))
     RETURNING *`,
    [id, waitlistEntryId, showSeatIds, tokenHash, attemptNo, offerTtlSeconds]
  );
  return mapOfferRow(result.rows[0]);
}

/**
 * P5-5's read: looks up an offer by the SHA-256 hash of a presented raw token (offers.service.js
 * computes the hash; this file never sees the raw value). `isExpired`/`secondsRemaining` are
 * computed in SQL against Postgres's own `now()`, never the app clock (CLAUDE.md) -- the caller
 * decides what an expired or non-PENDING result means (OfferInvalidError vs OfferExpiredError),
 * this function only reports the facts.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} tokenHash
 * @returns {Promise<(object & { isExpired: boolean, secondsRemaining: number }) | null>}
 */
export async function findOfferByTokenHash(client, tokenHash) {
  const result = await client.query(
    `SELECT *, (expires_at <= now()) AS is_expired,
            GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now())))::int AS seconds_remaining
       FROM waitlist_offers WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...mapOfferRow(row), isExpired: row.is_expired, secondsRemaining: row.seconds_remaining };
}

/**
 * The seats an offer names, with pricing -- same shape as bookings.queries.js#findHoldSeats, keyed
 * by an explicit id array (`waitlist_offers.show_seat_ids`) instead of a hold_id, since an offer
 * has no single parent row on show_seats the way a hold's `hold_id` column gives one. Not `FOR
 * UPDATE`: same reasoning as findHoldSeats -- this is an advisory read for pricing/display, not
 * the correctness boundary (confirmOfferSeats() below is).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string[]} showSeatIds
 * @returns {Promise<Array<{ showSeatId: string, seatId: string, showId: string, categoryId: string, priceCents: number | null, rowLabel: string, seatNumber: number }>>}
 */
export async function findOfferSeatsByIds(client, showSeatIds) {
  const result = await client.query(
    `SELECT ss.id AS show_seat_id, ss.seat_id, ss.show_id, ss.category_id,
            sp.price_cents, s.row_label, s.seat_number
       FROM show_seats ss
       JOIN seats s ON s.id = ss.seat_id
       LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
      WHERE ss.id = ANY($1::uuid[])`,
    [showSeatIds]
  );
  return result.rows.map((row) => ({
    showSeatId: row.show_seat_id,
    seatId: row.seat_id,
    showId: row.show_id,
    categoryId: row.category_id,
    priceCents: row.price_cents,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
  }));
}

/**
 * WALKTHROUGH: confirmOfferSeats(), the OFFER_RESERVED -> BOOKED counterpart to
 * bookings.queries.js#confirmHeldSeats -- reusing the exact same guarded-transaction shape D-40
 * anticipated, this time with `fromState` genuinely different (OFFER_RESERVED, not HELD).
 *
 * 1. One `UPDATE`, gated on `id = ANY($2)` (this offer's exact seats) AND `state = 'OFFER_RESERVED'`
 *    AND `expires_at > now()` -- the SAME Layer-1 lazy-expiry predicate every other atomic step in
 *    this codebase uses, so an offer whose window lapsed the instant before this ran is correctly
 *    rejected without any scheduler needing to have touched the row first.
 * 2. What a DOUBLE-ACCEPT (the same token POSTed twice, concurrently) experiences: both
 *    transactions target the identical seat id array. Under READ COMMITTED (§6.2), whichever
 *    commits first flips every seat to BOOKED; the second's UPDATE blocks on the row lock, then
 *    re-evaluates `state = 'OFFER_RESERVED'` against the now-BOOKED rows once unblocked -- it no
 *    longer matches, `RETURNING` comes back short, and offers.service.js#acceptOffer rolls back
 *    that second transaction's booking insert and payment capture together. This is the actual
 *    single-use guarantee; `markOfferAccepted()` below is bookkeeping, not the boundary.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ showSeatIds: string[], bookingId: string }} params
 * @returns {Promise<string[]>} show_seat ids actually confirmed -- caller MUST compare this
 *   length against `showSeatIds.length` and roll back on any shortfall
 */
export async function confirmOfferSeats(client, { showSeatIds, bookingId }) {
  const result = await client.query(
    `UPDATE show_seats
        SET state = 'BOOKED', booking_id = $1, expires_at = NULL, reserved_until = NULL, hold_id = NULL,
            version = version + 1, updated_at = now()
      WHERE id = ANY($2::uuid[]) AND state = 'OFFER_RESERVED' AND expires_at > now()
     RETURNING id`,
    [bookingId, showSeatIds]
  );
  return result.rows.map((row) => row.id);
}

/**
 * Bookkeeping, not the correctness boundary (confirmOfferSeats() is) -- same idiom as
 * holds.queries.js#markSeatHoldReleased: predicate-gated (`status = 'PENDING'`) so a second call
 * (which shouldn't happen, since confirmOfferSeats() already rejects a second accept) is a no-op
 * rather than an error.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} offerId
 * @returns {Promise<object | null>}
 */
export async function markOfferAccepted(client, offerId) {
  const result = await client.query(
    `UPDATE waitlist_offers SET status = 'ACCEPTED' WHERE id = $1 AND status = 'PENDING' RETURNING *`,
    [offerId]
  );
  return mapOfferRow(result.rows[0]);
}
