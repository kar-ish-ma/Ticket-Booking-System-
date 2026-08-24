/**
 * offers.service.js
 *
 * Owns offer creation orchestration. `createInitialOffer()` (P5-3) is the cancellation flow's
 * OFFER_RESERVED branch: called from inside bookings.service.js#cancelBooking's own transaction,
 * once per category that has a waiting entry.
 *
 * Does NOT own: the SQL itself (offers.queries.js), picking who gets offered a seat
 * (waitlist.queries.js#claimNextWaitingEntry, already run by the caller before this is invoked),
 * or the cascade re-offer that reuses these same OFFER_RESERVED seats after this offer lapses
 * (P5-6's cascadeOffer(), not built yet).
 */

import crypto from 'node:crypto';

import { SEAT_STATES } from 'shared/seatStates.js';
import { assertTransition } from '../seatmap/seatState.machine.js';
import * as offersQueries from './offers.queries.js';
import * as waitlistQueries from './waitlist.queries.js';

// WHY a placeholder instead of docs/PROJECT_PROMPT.md §7.3's real raw+sha256 shape: that shape --
// generating a raw token, hashing it, returning the raw token so a caller can email a claim link,
// enforcing single-use on accept -- IS P5-4's entire task ("Single-use HMAC offer token; only the
// hash stored; raw only in the email link"), not a detail of P5-3's own scope (routing freed seats
// by category). Building it here would mean doing P5-4's work under P5-3's ticket. Same precedent
// as bookings.service.js's generatePlaceholderReference()/generatePlaceholderQrToken() (P4-2,
// deferring P4-4/P4-5) -- tracked as Phase 5 debt in docs/BUILD_LOG.md, replaced wholesale, not
// extended, when P5-4 lands. Nothing reads this value yet either: GET /waitlist/offers/:token and
// POST .../accept are P5-5, also not built.
function generatePlaceholderTokenHash() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Converts one category's freed seats into a live offer for the waiting entry the caller already
 * claimed (waitlist.queries.js#claimNextWaitingEntry, under FOR UPDATE, in the SAME transaction).
 * Must be called from inside that transaction -- see bookings.service.js#cancelBooking's own
 * WALKTHROUGH for why the whole dispatch (booking cancel, seat transition, this offer, the entry's
 * status flip) has to commit or roll back as one unit: a committed cancellation with a rolled-back
 * offer would leave seats OFFER_RESERVED for nobody -- invisible to the seat map, never swept by
 * any TTL layer built so far (all three key off show_seats.expires_at/reserved_until existing
 * alongside a real offer, not off a bare seat state), and not recoverable by any mechanism this
 * codebase has.
 *
 * @param {import('pg').PoolClient} client - must already be inside a transaction
 * @param {{ bookingId: string, categoryId: string, waitlistEntryId: string, offerTtlSeconds: number, maxCascadeAttempts: number }} params
 * @returns {Promise<{ seats: Array<{ showSeatId: string, seatId: string }>, offer: object }>}
 * @throws never; this function trusts the caller has already confirmed a waiting entry exists and
 *   that this category genuinely has BOOKED seats to transition -- an empty result here would be a
 *   caller bug, not a normal outcome, so it's not specially handled
 */
export async function createInitialOffer(
  client,
  { bookingId, categoryId, waitlistEntryId, offerTtlSeconds, maxCascadeAttempts }
) {
  // The D-40 call site docs/BUILD_LOG.md's Decisions Ledger anticipated for this exact pair
  // (BOOKED -> OFFER_RESERVED), landing here rather than in a function literally named
  // cascadeOffer() -- this is the FIRST offer (attempt_no: 1), conceptually distinct from P5-6's
  // cascade re-offers (OFFER_RESERVED -> OFFER_RESERVED, the self-loop shared/seatStates.js
  // documents separately). See Decisions Ledger D-47.
  assertTransition(SEAT_STATES.BOOKED, SEAT_STATES.OFFER_RESERVED);

  // docs/PROJECT_PROMPT.md §7.2, D-14: reserved_until is the fixed outer bound the WHOLE cascade
  // must finish inside -- a hard upper bound on how long ANY legitimate cascade can run, computed
  // once here and never touched again (P5-6 must not re-extend it on later cascade attempts).
  const reservedUntilSeconds = offerTtlSeconds * maxCascadeAttempts + 60;

  const seats = await offersQueries.transitionBookedSeatsToOfferReserved(client, {
    bookingId,
    categoryId,
    offerTtlSeconds,
    reservedUntilSeconds,
  });

  const offer = await offersQueries.insertWaitlistOffer(client, {
    waitlistEntryId,
    showSeatIds: seats.map((seat) => seat.showSeatId),
    tokenHash: generatePlaceholderTokenHash(),
    attemptNo: 1,
    offerTtlSeconds,
  });

  await waitlistQueries.markEntryOffered(client, waitlistEntryId);

  return { seats, offer };
}
