/**
 * bookings.queries.js
 *
 * Owns the raw SQL for turning a hold into a booking (`confirmHeldSeats()` — the atomic §6.5
 * statement this file was originally built around) and, since P4-8, cancelling one back out
 * (`releaseBookedSeats()` — the symmetric §7.2 statement). Also owns reading a hold's or a
 * booking's seats (with pricing/category) and writing the `bookings`/`booking_seats` rows around
 * those atomic steps.
 *
 * Does NOT own: deciding whether a short `confirmHeldSeats()` result means rollback, or which
 * category groups go to `OFFER_RESERVED` instead of `AVAILABLE` (§7.2/D-7 — that decision is
 * bookings.service.js#cancelBooking's, made by calling waitlist.queries.js#claimNextWaitingEntry
 * per category; this file's own `releaseBookedSeatsForCategory()` only ever writes `AVAILABLE`).
 * The `OFFER_RESERVED` write itself lives in offers.queries.js, not here — same split as
 * holds.queries.js#acquireSeats / holds.service.js#createHold. Also does not own payment
 * capture/refund (payments.service.js) or seat-hold bookkeeping
 * (holds.queries.js#markSeatHoldReleased, reused as-is for `'CONVERTED'`).
 *
 * Invariant: every function here takes a `client` that must already be inside a transaction (see
 * withTransaction.js's header for why calling `pool.query` here instead would silently escape it).
 * `findBookingById` is the one read-only exception, accepting a bare `pool` too, for
 * `loadBookingForOwnership`'s route-middleware use — same dual-accept pattern as
 * holds.queries.js#findSeatHoldById.
 */

function mapBookingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    showId: row.show_id,
    userId: row.user_id,
    status: row.status,
    subtotalCents: row.subtotal_cents,
    feesCents: row.fees_cents,
    totalCents: row.total_cents,
    qrToken: row.qr_token,
    idempotencyKey: row.idempotency_key,
    checkedInAt: row.checked_in_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

/**
 * Every `show_seats` row still actively `HELD` under this hold, with the price its category is
 * charged at THIS show. Not `FOR UPDATE` — the correctness-critical step is confirmHeldSeats()'s
 * own guarded `UPDATE` below, not this read; the same reasoning holds.queries.js's own header
 * gives for why acquireSeats()'s outer predicate, not an earlier read, is what actually matters.
 * If this hold's TTL lapses between this read and confirmHeldSeats() running, that UPDATE's own
 * `expires_at > now()` predicate is what catches it — not a stale read here.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} holdId
 * @returns {Promise<Array<{ showSeatId: string, seatId: string, showId: string, categoryId: string, priceCents: number | null, rowLabel: string, seatNumber: number }>>}
 *   `priceCents` is `null` only if the show was published without pricing this category (Phase 2
 *   debt) — bookings.service.js#confirmBooking treats that as a hard error, not a $0 charge.
 */
export async function findHoldSeats(client, holdId) {
  const result = await client.query(
    `SELECT ss.id AS show_seat_id, ss.seat_id, ss.show_id, ss.category_id,
            sp.price_cents, s.row_label, s.seat_number
       FROM show_seats ss
       JOIN seats s ON s.id = ss.seat_id
       LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
      WHERE ss.hold_id = $1 AND ss.state = 'HELD'`,
    [holdId]
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
 * @param {import('pg').PoolClient} client
 * @param {{ reference: string, showId: string, userId: string, subtotalCents: number, feesCents: number, totalCents: number, qrToken: string }} params
 * @returns {Promise<object>} the inserted booking, camelCased, `status: 'CONFIRMED'`
 */
export async function insertBooking(
  client,
  { reference, showId, userId, subtotalCents, feesCents, totalCents, qrToken }
) {
  const result = await client.query(
    `INSERT INTO bookings (reference, show_id, user_id, status, subtotal_cents, fees_cents, total_cents, qr_token)
     VALUES ($1, $2, $3, 'CONFIRMED', $4, $5, $6, $7)
     RETURNING *`,
    [reference, showId, userId, subtotalCents, feesCents, totalCents, qrToken]
  );
  return mapBookingRow(result.rows[0]);
}

/**
 * One `unnest()`-based bulk insert, same shape as venues.queries.js#insertSeatsBulk and
 * shows.queries.js#insertShowPrices — a single round trip regardless of seat count, and the
 * parameter count stays fixed no matter how many seats this booking covers.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} bookingId
 * @param {Array<{ showSeatId: string, priceCents: number }>} seats
 * @returns {Promise<void>}
 */
export async function insertBookingSeats(client, bookingId, seats) {
  await client.query(
    `INSERT INTO booking_seats (booking_id, show_seat_id, price_cents)
     SELECT $1, * FROM unnest($2::uuid[], $3::int[]) AS t(show_seat_id, price_cents)`,
    [bookingId, seats.map((s) => s.showSeatId), seats.map((s) => s.priceCents)]
  );
}

/**
 * WALKTHROUGH: confirmHeldSeats(), the literal docs/PROJECT_PROMPT.md §6.5 statement, and what
 * the loser of a race experiences
 *
 * 1. One `UPDATE`, no CTE and no `FOR UPDATE` needed the way acquireSeats() needs one: every row
 *    this statement could possibly touch is already scoped to a SINGLE hold_id, so there is no
 *    multi-transaction lock-ordering deadlock to worry about the way overlapping DIFFERENT holds'
 *    seat sets could deadlock each other in holds.queries.js#acquireSeats — two attempts to
 *    confirm the SAME hold target the exact same row set, not merely an overlapping one, so they
 *    naturally serialise on Postgres's own row locks with no ordering decision required.
 * 2. The `WHERE` clause is the entire correctness boundary: `hold_id = $2` (only this hold's
 *    seats), `state = 'HELD'` (not already booked, cancelled-back-to-available, or reclaimed by
 *    someone else's expired-hold acquire), `expires_at > now()` (the TTL has not lapsed — Layer 1
 *    of the TTL design, same predicate-is-the-truth principle as everywhere else in this codebase).
 * 3. What the loser of a DOUBLE-SUBMIT experiences (the same holdId confirmed twice concurrently,
 *    e.g. a double-click on "Confirm"): both transactions read the identical
 *    findHoldSeats() result and both reach this statement. Under READ COMMITTED (§6.2, Decisions
 *    Ledger D-3), whichever commits first flips the seats to `BOOKED`; the second transaction's
 *    `UPDATE` blocks on the row lock, then re-evaluates `state = 'HELD'` against the
 *    now-committed `BOOKED` row once unblocked — it no longer matches, `RETURNING` comes back
 *    short (here, empty, since all-or-nothing is a single hold), and
 *    bookings.service.js#confirmBooking rolls back that second transaction's booking insert and
 *    payment capture together. One booking, one payment capture — never two, with no retry loop
 *    and no application-level lock, the same argument §6.2 already makes for acquireSeats().
 * 4. What happens if this confirm instead races an explicit `DELETE /holds/:id` on the same hold:
 *    if the release commits first, this predicate finds the seat `AVAILABLE` (not `HELD`) and
 *    matches nothing — rollback, `HoldExpiredError`. If this confirm commits first, the seat is
 *    already `BOOKED` by the time a release arrives; `releaseHoldSeats()`'s own
 *    `WHERE hold_id = $1 AND state = 'HELD'` (P3-4) then matches nothing either — its already-
 *    idempotent no-op (`released: 0`), unchanged. Neither function needed to be taught about the
 *    other; each one's own predicate is what makes the composition safe.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ holdId: string, bookingId: string }} params
 * @returns {Promise<string[]>} show_seat ids actually confirmed — caller MUST compare this
 *   length against how many seats findHoldSeats() reported and roll back on any shortfall
 * @throws never; a lapsed or already-confirmed hold is signalled by a short/empty array, not an
 *   exception — same contract shape as holds.queries.js#acquireSeats
 */
export async function confirmHeldSeats(client, { holdId, bookingId }) {
  const result = await client.query(
    `UPDATE show_seats
        SET state = 'BOOKED', booking_id = $1, expires_at = NULL, hold_id = NULL,
            version = version + 1, updated_at = now()
      WHERE hold_id = $2 AND state = 'HELD' AND expires_at > now()
     RETURNING id`,
    [bookingId, holdId]
  );
  return result.rows.map((row) => row.id);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} bookingId
 * @returns {Promise<object | null>}
 */
export async function findBookingById(client, bookingId) {
  const result = await client.query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  return mapBookingRow(result.rows[0]);
}

/**
 * Marks the booking cancelled. `status = 'CONFIRMED'` in the WHERE clause is what makes a second
 * call a no-op instead of re-stamping `cancelled_at` — same idiom as
 * holds.queries.js#markSeatHoldReleased and payments.queries.js#markPaymentRefunded: the
 * predicate IS the idempotency, not a separate "already cancelled" branch.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} bookingId
 * @returns {Promise<object | null>} the cancelled booking, or `null` if it wasn't `CONFIRMED`
 *   (already cancelled, or never reached that status) — a normal, idempotent outcome
 */
export async function markBookingCancelled(client, bookingId) {
  const result = await client.query(
    `UPDATE bookings SET status = 'CANCELLED', cancelled_at = now()
      WHERE id = $1 AND status = 'CONFIRMED'
     RETURNING *`,
    [bookingId]
  );
  return mapBookingRow(result.rows[0]);
}

/**
 * A plain read (not `FOR UPDATE`) of every `show_seats` row still `BOOKED` under this booking,
 * grouped implicitly by returning `category_id`/`show_id` on each row so
 * bookings.service.js#cancelBooking can group them in JS before deciding, PER CATEGORY, whether
 * that group goes to `AVAILABLE` or `OFFER_RESERVED` (§7.2/D-7). Not locked here for the same
 * reason `findHoldSeats()` isn't: the correctness-critical step is each category's own guarded
 * `UPDATE` below (or offers.queries.js#transitionBookedSeatsToOfferReserved) — this read only
 * decides WHICH categories exist to loop over, and `markBookingCancelled()`'s own
 * `WHERE status = 'CONFIRMED'` predicate (called immediately before this, in the same transaction)
 * already guarantees at most one concurrent cancelBooking() call gets this far for a given
 * bookingId.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} bookingId
 * @returns {Promise<Array<{ showSeatId: string, seatId: string, categoryId: string, showId: string }>>}
 *   empty if this booking has no seats currently `BOOKED` — already cancelled, or never reached
 *   `BOOKED` in the first place
 */
export async function findBookedSeatsByBooking(client, bookingId) {
  const result = await client.query(
    `SELECT id AS show_seat_id, seat_id, category_id, show_id
       FROM show_seats
      WHERE booking_id = $1 AND state = 'BOOKED'`,
    [bookingId]
  );
  return result.rows.map((row) => ({
    showSeatId: row.show_seat_id,
    seatId: row.seat_id,
    categoryId: row.category_id,
    showId: row.show_id,
  }));
}

/**
 * The `AVAILABLE` branch of §7.2's cancellation flow, scoped to one category of one booking —
 * the counterpart to offers.queries.js#transitionBookedSeatsToOfferReserved, which handles the
 * other branch. Scoping by `category_id`, not just `booking_id`, is what lets
 * bookings.service.js#cancelBooking route a multi-category booking's groups independently: one
 * category's seats can land here while another's land in offers.queries.js, in the SAME
 * transaction, without either statement touching rows the other one owns.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ bookingId: string, categoryId: string }} params
 * @returns {Promise<Array<{ seatId: string, showSeatId: string }>>} seats actually released —
 *   empty is a normal, idempotent outcome (already released, or this category was never BOOKED
 *   under this booking), never an error
 */
export async function releaseBookedSeatsForCategory(client, { bookingId, categoryId }) {
  const result = await client.query(
    `UPDATE show_seats
        SET state = 'AVAILABLE', booking_id = NULL, version = version + 1, updated_at = now()
      WHERE booking_id = $1 AND category_id = $2 AND state = 'BOOKED'
     RETURNING seat_id, id AS show_seat_id`,
    [bookingId, categoryId]
  );
  return result.rows.map((row) => ({ seatId: row.seat_id, showSeatId: row.show_seat_id }));
}
