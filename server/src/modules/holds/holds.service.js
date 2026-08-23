/**
 * holds.service.js
 *
 * Owns hold orchestration: creating the parent `seat_holds` row and acquiring show_seats in one
 * transaction, and deciding whether a short `acquireSeats()` result is acceptable — it never is;
 * see createHold()'s shortfall check for why that decision belongs here and not in
 * holds.queries.js.
 *
 * Does NOT own: the acquire SQL itself (holds.queries.js) or HTTP concerns
 * (holds.controller.js). Idempotent releaseHold() and TTL registration across all three layers
 * (P3-4/P3-5) land in this same file as those tasks are built — it grows, it doesn't get
 * rewritten.
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
