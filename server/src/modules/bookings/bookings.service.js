/**
 * bookings.service.js
 *
 * Owns hold→booking orchestration (confirmBooking(), one of CLAUDE.md's four named hard
 * mechanisms) and, since P4-8, its inverse (cancelBooking()). Both carry their own numbered
 * WALKTHROUGH-style comments.
 *
 * Does NOT own: the SQL itself (bookings.queries.js), payment capture/refund
 * (payments.service.js), or HTTP concerns (bookings.controller.js). Booking history/detail/PDF
 * (P4-9) is a separate, later task — this file grows to hold it, it isn't rewritten for it.
 * cancelBooking()'s waitlist/offer routing (§7.2's `OFFER_RESERVED` branch, P5-3) is also deferred
 * — see that function's own comment for exactly where it slots in.
 */

import crypto from 'node:crypto';

import { withTransaction } from '../../db/withTransaction.js';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { HoldExpiredError } from '../../utils/errors.js';
import { SEAT_STATES } from 'shared/seatStates.js';
import { assertTransition } from '../seatmap/seatState.machine.js';
import * as bookingsQueries from './bookings.queries.js';
import * as holdsQueries from '../holds/holds.queries.js';
import * as paymentsService from '../payments/payments.service.js';

// WHY these two generators live here, inline and unexported, instead of in their own files:
// docs/BUILD_LOG.md's P4-2 row records this explicitly as Phase 4 debt, not a finished feature.
// bookings.reference and bookings.qr_token are both NOT NULL (004_bookings.sql), so
// confirmBooking() needs SOMETHING here today -- but the real P4-4 (Crockford base32, no
// ambiguous characters, a 100k-collision unit test) and P4-5 (signed JWT -> PNG buffer) were
// deliberately skipped for now (user directive) to keep this task scoped to the mechanism §6.5 is
// actually about. Neither generator here is cryptographically meaningful or collision-tested;
// both are replaced wholesale, not extended, when P4-4/P4-5 are built for real.
function generatePlaceholderReference() {
  return `TB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function generatePlaceholderQrToken() {
  return `QR-${crypto.randomUUID()}`;
}

/**
 * WALKTHROUGH: confirmBooking(), and what the loser of a race experiences
 *
 * 1. Read every show_seats row still HELD under this holdId (bookings.queries.js#findHoldSeats).
 *    Empty means this hold has nothing left to confirm -- expired, already released, or already
 *    converted by an earlier request -- so this throws HoldExpiredError immediately, before any
 *    write. The SQL predicate is the truth here, not a separate seat_holds.status read: no matter
 *    WHY the hold is over, "zero seats currently HELD under it" is the one fact that matters.
 * 2. Compute subtotal/fees/total from each seat's show_prices row. A null price_cents (a category
 *    the show was published without pricing -- Phase 2 debt) throws a plain Error, not a
 *    DomainError -- an unpriced seat reaching checkout is a data-setup bug, not a normal outcome
 *    a customer-facing error code should describe.
 * 3. Insert the booking row directly at status 'CONFIRMED' -- this mock payment gateway never
 *    declines, and the whole insert lives inside this one transaction anyway, so 'PENDING' would
 *    never be observably persisted even if used as an intermediate step.
 * 4. payments.service.js#authorizeAndCapture() -- P4-1, called before the seat transition below so
 *    a payment failure (impossible in this mock, but the ordering still models a real gateway
 *    honestly) never flips a seat to BOOKED first.
 * 5. assertTransition(HELD, BOOKED) -- immediately before the atomic UPDATE, the call site
 *    Decisions Ledger D-40 promised. It cannot fail today: fromState is hardcoded to HELD because
 *    this function only ever handles a hold-to-booking transition. Its value arrives with §7.3's
 *    offer-accept flow (Phase 5), which reuses "the same guarded transaction shape" for
 *    OFFER_RESERVED -> BOOKED -- once that shape takes fromState as a parameter instead of a
 *    literal, this call stops being trivially true and starts catching a caller passing the wrong
 *    pair, before a single row is touched.
 * 6. bookings.queries.js#confirmHeldSeats() -- the literal §6.5 UPDATE. Compare its RETURNING
 *    count against how many seats findHoldSeats() found in step 1: short (including zero) means
 *    the TTL lapsed, or a concurrent double-submit already won (see that function's own
 *    WALKTHROUGH for the full race account) -- ROLLBACK the whole transaction, HoldExpiredError.
 *    This mirrors holds.service.js#createHold's shortfall check (Decisions Ledger D-35): the SQL
 *    handles correctness per row, this function is what decides a request-level shortfall means
 *    nothing about this request succeeds.
 * 7. bookings.queries.js#insertBookingSeats() -- the historical price record (booking_seats,
 *    004_bookings.sql's own header comment on why it exists separately from
 *    show_seats.booking_id: prices change, a booking must still show what was actually charged).
 * 8. holds.queries.js#markSeatHoldReleased(holdId, 'CONVERTED') -- reused as-is from P3-4, closing
 *    out this hold's own bookkeeping row the same way an explicit release or a TTL expiry would,
 *    just with a status that says WHY it ended.
 *
 * @param {{ holdId: string, userId: string }} params
 * @returns {Promise<{ booking: object, seats: object[] }>}
 * @throws {HoldExpiredError} if this hold has no seats currently HELD under it, either before any
 *   write (step 1) or discovered by a short confirmHeldSeats() result (step 6)
 */
export async function confirmBooking({ holdId, userId }) {
  return withTransaction(async (client) => {
    const heldSeats = await bookingsQueries.findHoldSeats(client, holdId);
    if (heldSeats.length === 0) {
      throw new HoldExpiredError();
    }

    const unpriced = heldSeats.find((seat) => seat.priceCents === null);
    if (unpriced) {
      throw new Error(
        `confirmBooking: show ${unpriced.showId} has no show_prices row for category ` +
          `${unpriced.categoryId} -- cannot charge for seat ${unpriced.rowLabel}${unpriced.seatNumber}`
      );
    }

    const subtotalCents = heldSeats.reduce((sum, seat) => sum + seat.priceCents, 0);
    const feesCents = Math.round((subtotalCents * env.BOOKING_FEE_PERCENT) / 100);
    const totalCents = subtotalCents + feesCents;

    const booking = await bookingsQueries.insertBooking(client, {
      reference: generatePlaceholderReference(),
      showId: heldSeats[0].showId,
      userId,
      subtotalCents,
      feesCents,
      totalCents,
      qrToken: generatePlaceholderQrToken(),
    });

    await paymentsService.authorizeAndCapture(client, { bookingId: booking.id, amountCents: totalCents });

    // The D-40 call site -- see this function's own WALKTHROUGH step 5 for why it's trivially
    // true today and what makes it stop being trivial later.
    assertTransition(SEAT_STATES.HELD, SEAT_STATES.BOOKED);

    const confirmedSeatIds = await bookingsQueries.confirmHeldSeats(client, {
      holdId,
      bookingId: booking.id,
    });
    if (confirmedSeatIds.length < heldSeats.length) {
      // Throwing inside withTransaction's callback rolls back the booking insert AND the payment
      // capture together (withTransaction.js's own header) -- nothing survives a shortfall here.
      throw new HoldExpiredError();
    }

    await bookingsQueries.insertBookingSeats(
      client,
      booking.id,
      heldSeats.map((seat) => ({ showSeatId: seat.showSeatId, priceCents: seat.priceCents }))
    );
    await holdsQueries.markSeatHoldReleased(client, holdId, 'CONVERTED');

    return { booking, seats: heldSeats };
  });
}

/**
 * requireOwnership.js's loader shape, for POST /bookings/confirm specifically -- reads
 * req.body.holdId, not req.params.id, since confirm's holdId arrives in the request body (§9:
 * `POST /bookings/confirm { holdId, ... }`), unlike DELETE /holds/:id's path param. Reuses
 * holds.queries.js#findSeatHoldById rather than duplicating it; only the field req reads from
 * differs from holds.service.js#loadHoldForOwnership.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ownerId: string } | null>}
 */
export async function loadHoldForOwnershipFromConfirmBody(req) {
  const hold = await holdsQueries.findSeatHoldById(pool, req.body.holdId);
  return hold ? { ownerId: hold.userId } : null;
}

/**
 * WALKTHROUGH: cancelBooking(), and why three concurrent cancel attempts is a normal case
 *
 * Same unconditional-calls style as holds.service.js#releaseHold() (P3-4), not an early-return
 * guard: every step below runs every time this is called, and each step's OWN predicate is what
 * makes a repeat call a no-op. A double-click on "Cancel," or a retried request after a dropped
 * response, experiences exactly the same idempotency §5.2 already established for holds -- no new
 * pattern to learn here, the same one reused.
 *
 * 1. bookings.queries.js#markBookingCancelled() -- `WHERE status = 'CONFIRMED'` is the gate. First
 *    call: matches, flips to CANCELLED, stamps cancelled_at. Second call: the row is already
 *    CANCELLED, matches nothing, returns null -- this is what makes the function's own return
 *    value (`cancelled: booking !== null`) accurately report "did THIS call do the cancelling."
 * 2. payments.service.js#refund() (P4-1) -- called unconditionally, not gated on step 1's result.
 *    Its own `WHERE status = 'CAPTURED'` predicate is independently idempotent, already falsified
 *    live at P4-1. A second cancelBooking() call refunds nothing new; no new code on either side
 *    had to be written to make that composition safe.
 * 3. assertTransition(BOOKED, AVAILABLE) -- extends the D-40/D-44 reasoning to a third call site
 *    (Decisions Ledger D-45): this is also a transition decided in application code before a
 *    single-row UPDATE, not a multi-branch predicate the way holds.queries.js#acquireSeats needs
 *    one. Trivially true today for the same reason D-44 gave for confirmBooking().
 * 4. bookings.queries.js#releaseBookedSeats() -- the §7.2 counterpart to confirmHeldSeats(). A
 *    second call's `WHERE state = 'BOOKED'` matches nothing (already AVAILABLE) -- empty array,
 *    not an error.
 * 5. **Group the released seats by categoryId.** §7.2's own cancellation diagram frames the
 *    decision this way -- "for each category group: queue empty -> AVAILABLE; queue head ->
 *    OFFER_RESERVED" -- because different categories of the SAME cancelled booking can have
 *    different waitlist depths. Every group resolves to AVAILABLE here, unconditionally: this is
 *    where Phase 5's P5-3 inserts its branch, checking each group's waitlist head-of-queue
 *    (`FOR UPDATE SKIP LOCKED`, §7.4) and routing non-empty groups to OFFER_RESERVED instead. WHY
 *    that second branch has to exist at all, not just "release everything, always" — Decisions
 *    Ledger D-7: a seat freed by a cancellation must never re-enter the public pool while a
 *    waitlist offer on it is live, or a random browser snipes the seat the queue was promised.
 *    Grouping by category here, even with only one branch implemented, is what lets P5-3 slot in
 *    without restructuring this function.
 *
 * @param {{ bookingId: string }} params
 * @returns {Promise<{ cancelled: boolean, releasedSeatsByCategory: Map<string, Array<{ seatId: string, categoryId: string, showId: string }>> }>}
 * @throws never; cancelling an already-cancelled or nonexistent-under-CONFIRMED booking is a
 *   normal, idempotent outcome (`cancelled: false`), not an error
 */
export async function cancelBooking({ bookingId }) {
  return withTransaction(async (client) => {
    const booking = await bookingsQueries.markBookingCancelled(client, bookingId);

    await paymentsService.refund(client, bookingId);

    // See this function's own WALKTHROUGH step 3 / Decisions Ledger D-45.
    assertTransition(SEAT_STATES.BOOKED, SEAT_STATES.AVAILABLE);

    const releasedSeats = await bookingsQueries.releaseBookedSeats(client, bookingId);

    const releasedSeatsByCategory = new Map();
    for (const seat of releasedSeats) {
      const group = releasedSeatsByCategory.get(seat.categoryId) ?? [];
      group.push(seat);
      releasedSeatsByCategory.set(seat.categoryId, group);
    }
    // WHY every group above resolves to AVAILABLE, unconditionally, rather than checking the
    // waitlist here: that's §7.2's OFFER_RESERVED branch, deliberately deferred to Phase 5's
    // P5-3 -- see this function's own WALKTHROUGH step 5 and Decisions Ledger D-7 for why the
    // grouping already exists even though only one outcome is implemented today.

    return { cancelled: booking !== null, releasedSeatsByCategory };
  });
}

/**
 * requireOwnership.js's loader shape, for POST /bookings/:id/cancel -- reads req.params.id (the
 * bookingId), mirroring holds.service.js#loadHoldForOwnership's shape exactly for the same kind
 * of resource-ownership check, just against bookings instead of holds.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ownerId: string } | null>}
 */
export async function loadBookingForOwnership(req) {
  const booking = await bookingsQueries.findBookingById(pool, req.params.id);
  return booking ? { ownerId: booking.userId } : null;
}
