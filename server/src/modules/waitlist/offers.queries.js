/**
 * offers.queries.js
 *
 * Owns the raw SQL for waitlist_offers, and the show_seats transition into OFFER_RESERVED that
 * creating an offer requires -- the two always change together (a waitlist_offers row with no
 * OFFER_RESERVED seats behind it, or vice versa, is exactly the corrupt state a shared transaction
 * boundary exists to rule out; see offers.service.js#createInitialOffer's own header).
 *
 * Does NOT own: picking WHO gets offered a seat (waitlist.queries.js#claimNextWaitingEntry), the
 * token itself (a placeholder as of P5-3 -- see offers.service.js), or orchestration across
 * multiple categories (bookings.service.js#cancelBooking).
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
 * @param {{ waitlistEntryId: string, showSeatIds: string[], tokenHash: string, attemptNo: number, offerTtlSeconds: number }} params
 * @returns {Promise<object>} the created offer, camelCased, status PENDING
 * @throws {Error} with `.code === '23505'` on a token_hash collision -- astronomically unlikely
 *   even with P5-3's placeholder token (32 random bytes), not caught specially here; a real
 *   collision would be a bug worth a loud failure, not a silent retry
 */
export async function insertWaitlistOffer(
  client,
  { waitlistEntryId, showSeatIds, tokenHash, attemptNo, offerTtlSeconds }
) {
  const result = await client.query(
    `INSERT INTO waitlist_offers (waitlist_entry_id, show_seat_ids, token_hash, attempt_no, expires_at)
     VALUES ($1, $2::uuid[], $3, $4, now() + make_interval(secs => $5))
     RETURNING *`,
    [waitlistEntryId, showSeatIds, tokenHash, attemptNo, offerTtlSeconds]
  );
  return mapOfferRow(result.rows[0]);
}
