/**
 * holds.service.js
 *
 * Owns hold orchestration: creating the parent `seat_holds` row and acquiring show_seats in one
 * transaction, and deciding whether a short `acquireSeats()` result is acceptable — it never is;
 * see createHold()'s shortfall check for why that decision belongs here and not in
 * holds.queries.js.
 *
 * Does NOT own: the acquire/release SQL itself (holds.queries.js) or HTTP concerns
 * (holds.controller.js). TTL job-queue registration (P3-5) and socket broadcasting (P3-6) are
 * deferred — see releaseHold()'s own comment for exactly what that means for this file today.
 */

import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/withTransaction.js';
import { env } from '../../config/env.js';
import { NotFoundError, SeatsUnavailableError, ValidationError } from '../../utils/errors.js';
import * as holdsQueries from './holds.queries.js';
import * as showsQueries from '../shows/shows.queries.js';

/**
 * @param {{ showId: string, seatIds: string[], userId: string }} params
 * @returns {Promise<{ hold: { id: string, expiresAt: Date }, seatIds: string[] }>}
 * @throws {ValidationError} if more seats are requested than MAX_SEATS_PER_BOOKING allows
 * @throws {NotFoundError} if no show has this id
 * @throws {SeatsUnavailableError} if any requested seat couldn't be acquired — see the shortfall
 *   check below for why this means NO seat ends up held, not just the contested ones
 */
export async function createHold({ showId, seatIds, userId }) {
  // Checked before any DB round-trip: a pure request-shape rule, independent of which show or
  // seats were requested. shared/schemas/hold.schema.js can't enforce this itself -- it has no
  // way to read server-only env (see that file's own header).
  if (seatIds.length > env.MAX_SEATS_PER_BOOKING) {
    throw new ValidationError(`Cannot hold more than ${env.MAX_SEATS_PER_BOOKING} seats at once`);
  }

  const show = await showsQueries.findShowById(pool, showId);
  if (!show) throw new NotFoundError('Show not found');

  return withTransaction(async (client) => {
    // The seat_holds row is created BEFORE acquireSeats() runs, in the SAME transaction, so a
    // rollback below (the shortfall branch) undoes both together. If this insert ever ran
    // outside the transaction acquireSeats() uses, a shortfall rollback would undo the seat
    // acquisition but leave this row behind -- an ACTIVE hold owning zero seats, invisible to the
    // seatmap (which reads show_seats, not seat_holds) and never cleaned up by any of the three
    // TTL layers (they all key off show_seats.expires_at, not seat_holds.expires_at directly).
    const hold = await holdsQueries.insertSeatHold(client, {
      showId,
      userId,
      ttlSeconds: show.holdTtlSeconds,
    });

    const acquiredSeatIds = await holdsQueries.acquireSeats(client, {
      showId,
      seatIds,
      holdId: hold.id,
      userId,
      ttlSeconds: show.holdTtlSeconds,
    });

    // WHY this check exists even though acquireSeats() already ran the correctness-bearing SQL:
    // Decisions Ledger D-35, found live while proving P3-2's overlapping-set race. acquireSeats()
    // is deliberately NOT all-or-nothing on its own -- its RETURNING set is exactly which rows
    // THAT ONE STATEMENT legally touched. For an overlapping multi-seat race, the side that loses
    // only the CONTESTED seat can still independently win an uncontested one in the same
    // statement, coming back with a genuinely non-empty but short array (proven live: P3-2's
    // scenario 8, docs/TESTING.md). This ROLLBACK is the ONLY place "the loser holds zero seats"
    // (docs/PROJECT_PROMPT.md §6.6) actually becomes true. The tempting "optimisation" of
    // deleting this check because "the query already handles it" is exactly backwards: the query
    // handles correctness PER ROW, never per REQUEST -- that's this function's job. Removing this
    // check silently reintroduces a partial hold: a customer shown seats they don't actually have.
    if (acquiredSeatIds.length < seatIds.length) {
      const missingSeatIds = seatIds.filter((id) => !acquiredSeatIds.includes(id));
      const conflictingSeats = await holdsQueries.findSeatLabels(client, showId, missingSeatIds);
      // Throwing inside withTransaction's callback is what triggers its ROLLBACK (see that
      // file's header) -- undoing the seat_holds insert above AND every show_seats row
      // acquireSeats() DID manage to flip, together, in one statement. Nothing is left
      // half-acquired.
      throw new SeatsUnavailableError(conflictingSeats);
    }

    return { hold, seatIds: acquiredSeatIds };
  });
}

/**
 * WALKTHROUGH: releaseHold(), and why three layers racing to call it is the normal case
 *
 * 1. Two independent UPDATEs, one transaction: releaseHoldSeats() frees every show_seats row
 *    still governed by this hold (`hold_id = $1 AND state = 'HELD'`); markSeatHoldReleased()
 *    flips the parent seat_holds row's own bookkeeping (`id = $1 AND status = 'ACTIVE'`). Both
 *    predicates are satisfied-or-not independently of each other — neither reads the other's
 *    result — so there is nothing here that can succeed on one and fail on the other in a way
 *    that matters: if this transaction commits, both ran; if it doesn't, neither did.
 * 2. First call on a genuinely ACTIVE hold: both predicates match, both UPDATEs make real
 *    changes, `released` comes back equal to however many seats this hold held. Ordinary case.
 * 3. Second call on the SAME holdId (double release): by now the show_seats rows are already
 *    `AVAILABLE`, not `HELD` — releaseHoldSeats()'s predicate matches nothing. The seat_holds row
 *    is already `RELEASED`/`EXPIRED`, not `ACTIVE` — markSeatHoldReleased()'s predicate matches
 *    nothing either. Both UPDATEs run, both affect 0 rows, `released: 0`, no exception, no
 *    special-cased "already released" branch anywhere in this code — the SQL predicates ARE the
 *    idempotency (docs/PROJECT_PROMPT.md §5.2: "releasing an already-released hold returns
 *    { released: 0 } — never an error").
 * 4. §5.2's literal claim — "three layers racing to release the same hold is the NORMAL case, not
 *    an edge case" — holds because of #3: an explicit DELETE, a P3-5 TTL job, and a P3-7 cron
 *    sweep can all call this for the same holdId around the same moment. Whichever transaction's
 *    UPDATEs commit first does the real work; every other one's predicates simply find nothing
 *    left to match, under READ COMMITTED's normal re-evaluate-after-lock-wait behaviour (§6.2) —
 *    no different in kind from acquireSeats()'s own race handling, just on a single row instead
 *    of a multi-row CTE, so there's no lock-ordering concern to worry about here at all.
 * 5. The one genuinely easy-to-get-wrong case, and why it's actually safe: releasing a STALE
 *    holdId whose seat has since been lazily reclaimed under a DIFFERENT hold. Say hold A's TTL
 *    lapsed, and acquireSeats() has already reclaimed its seat under a brand-new hold B
 *    (show_seats.hold_id is now B, not A). A late call to releaseHold(A) — a slow TTL job that
 *    only just got around to it, say — cannot touch B's seat: releaseHoldSeats()'s predicate is
 *    `hold_id = $1`, and that column no longer equals A. Nothing matches, nothing changes. And
 *    critically, `markSeatHoldReleased(A, ...)` is keyed on `id = $1` — hold A's OWN primary
 *    key — never on which seat A used to govern, so it correctly marks A's own row released
 *    while being structurally incapable of touching B's row, whose `id` is different. If either
 *    predicate were instead written as a join through the CURRENT seat (e.g. looking up "the
 *    hold that owns seat X" rather than "the hold with this id"), a stale release could silently
 *    clobber the wrong hold's bookkeeping. Proven live, not just reasoned about — see
 *    docs/TESTING.md.
 *
 * WHY no job-queue enqueue and no pg_notify call here: P3-5 (timely release via the job queue)
 * and P3-6 (pg_notify -> Socket.IO broadcast) are deferred to after Phase 5 (user directive,
 * 2026-08-24 — see docs/BUILD_LOG.md's Phase 3 table). Layer 1 (the SQL predicate) is what makes
 * this function's OUTCOME correct regardless; Layers 2/3 and the broadcast only make that outcome
 * arrive sooner and become visible live. This function is written so adding them later means
 * adding calls here, not restructuring what already exists.
 *
 * @param {string} holdId
 * @param {{ reason?: 'MANUAL' | 'TTL' }} [options]
 * @returns {Promise<{ released: number }>} how many seats this call actually freed — 0 is a
 *   normal, successful outcome, never an error
 * @throws never
 */
export async function releaseHold(holdId, { reason = 'MANUAL' } = {}) {
  // TTL means the SQL predicate (Layer 1) already decided this hold was over before anyone
  // called this function -- EXPIRED records that. Anything else (an explicit DELETE, a
  // sendBeacon on tab close) is a live decision by the holder -- RELEASED records that instead.
  const seatHoldStatus = reason === 'TTL' ? 'EXPIRED' : 'RELEASED';

  return withTransaction(async (client) => {
    const releasedSeatIds = await holdsQueries.releaseHoldSeats(client, holdId);
    await holdsQueries.markSeatHoldReleased(client, holdId, seatHoldStatus);
    return { released: releasedSeatIds.length };
  });
}

/**
 * requireOwnership.js's loader shape — see events.service.js#loadEventForOwnership for the same
 * pattern. Only the user who created a hold may release it early via DELETE /holds/:id.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ownerId: string } | null>}
 */
export async function loadHoldForOwnership(req) {
  const hold = await holdsQueries.findSeatHoldById(pool, req.params.id);
  return hold ? { ownerId: hold.userId } : null;
}
