/**
 * shows.service.js
 *
 * Owns show business logic: creating a show with its per-category prices in one transaction, and
 * — the one ⭐ mechanism this module exists for — publishShow(), which materialises show_seats.
 *
 * Does NOT own: HTTP concerns (shows.controller.js), the SQL itself (shows.queries.js), or
 * effective-state seat map reads (seatmap.service.js — publishShow() only creates AVAILABLE
 * rows; deciding what's *effectively* available, once holds exist in Phase 3, is that module's
 * job).
 */

import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/withTransaction.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import * as showsQueries from './shows.queries.js';

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

/**
 * Inserts the show and its price rows in one transaction — a show with zero prices for some
 * category isn't a state this codebase needs to represent, so both writes commit together or
 * neither does.
 *
 * @param {string} eventId
 * @param {object} input - validated createShowSchema shape
 * @returns {Promise<{ show: object, prices: object[] }>}
 * @throws {NotFoundError} if venueId or a prices[].categoryId doesn't exist
 */
export async function createShow(eventId, input) {
  const { prices, ...showFields } = input;

  try {
    return await withTransaction(async (client) => {
      const show = await showsQueries.insertShow(client, { eventId, ...showFields });
      const insertedPrices = await showsQueries.insertShowPrices(client, show.id, prices);
      return { show, prices: insertedPrices };
    });
  } catch (err) {
    if (err.code === FOREIGN_KEY_VIOLATION) {
      throw new NotFoundError('venueId or one of prices[].categoryId does not exist');
    }
    throw err;
  }
}

/**
 * @param {string} eventId
 * @returns {Promise<object[]>}
 */
export async function listShowsByEvent(eventId) {
  return showsQueries.listShowsByEvent(pool, eventId);
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {NotFoundError} if no show has this id
 */
export async function getShow(id) {
  const show = await showsQueries.findShowDetailById(pool, id);
  if (!show) throw new NotFoundError('Show not found');

  const prices = await showsQueries.listShowPrices(pool, id);
  return { ...show, prices };
}

/**
 * WALKTHROUGH: publishShow(), and what a double-publish attempt experiences
 *
 * 1. Load the show (for its venueId) and, in the same beat, count its existing show_seats rows.
 *    Zero means this show has never been published; anything else means it has.
 * 2. A nonzero count throws ConflictError immediately — no transaction opened, no write
 *    attempted. This is a plain check-then-act, not an atomic guard (Phase 2 debt — see
 *    docs/BUILD_LOG.md; the atomicity discipline Phase 3's holds.queries.js enforces with a
 *    single `FOR UPDATE` statement is deliberately not extended to this admin-only, one-time-
 *    per-show action). Two truly concurrent publish clicks can both pass this check.
 * 3. materialiseShowSeats() then runs inside a transaction. If two requests really did both pass
 *    step 2, `UNIQUE (show_id, seat_id)` (003_show_seats.sql) still makes it physically
 *    impossible for both inserts to succeed — the loser's INSERT raises unique_violation, caught
 *    below and reported as the same clean 409 a sequential double-publish would get, not a raw
 *    500.
 *
 * @param {string} showId
 * @returns {Promise<{ show: object, seatCount: number }>}
 * @throws {NotFoundError} if no show has this id
 * @throws {ConflictError} if this show has already been published
 */
export async function publishShow(showId) {
  const show = await showsQueries.findShowById(pool, showId);
  if (!show) throw new NotFoundError('Show not found');

  const existingSeatCount = await showsQueries.countShowSeats(pool, showId);
  if (existingSeatCount > 0) {
    throw new ConflictError('This show has already been published');
  }

  try {
    const seatCount = await withTransaction((client) =>
      showsQueries.materialiseShowSeats(client, showId, show.venueId)
    );
    return { show, seatCount };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError('This show has already been published');
    }
    throw err;
  }
}

/**
 * requireOwnership.js's loader shape — see events.service.js#loadEventForOwnership for the same
 * pattern. A show has no organiser_id of its own; ownership is inherited through its event, which
 * is exactly what shows.queries.js#findShowWithEventOwner's join resolves.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ownerId: string } | null>}
 */
export async function loadShowForOwnership(req) {
  const show = await showsQueries.findShowWithEventOwner(pool, req.params.id);
  return show ? { ownerId: show.organiserId } : null;
}
