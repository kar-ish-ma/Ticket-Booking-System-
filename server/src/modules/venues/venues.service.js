/**
 * venues.service.js
 *
 * Owns venue/category/seat business logic: translating a unique-constraint violation into a
 * clean ConflictError, and expanding a bulk-seat row spec into individual seat records before
 * handing them to venues.queries.js.
 *
 * Does NOT own: HTTP concerns (venues.controller.js) or the SQL itself (venues.queries.js).
 */

import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/withTransaction.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import * as venuesQueries from './venues.queries.js';

// Postgres's unique_violation SQLSTATE — see
// https://www.postgresql.org/docs/current/errcodes-appendix.html. Both category-name and
// seat-grid duplicates surface through this same code; venues.queries.js documents which
// constraint each caller can hit.
const UNIQUE_VIOLATION = '23505';

/**
 * @param {{ name: string, address: string, city: string, layoutMeta: object }} input
 * @returns {Promise<object>}
 */
export async function createVenue(input) {
  return venuesQueries.insertVenue(pool, input);
}

/**
 * @returns {Promise<object[]>}
 */
export async function listVenues() {
  return venuesQueries.listVenues(pool);
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {NotFoundError} if no venue has this id
 */
export async function getVenue(id) {
  const venue = await venuesQueries.findVenueById(pool, id);
  if (!venue) throw new NotFoundError('Venue not found');
  return venue;
}

/**
 * @param {string} venueId
 * @param {{ name: string, colorHex: string | undefined, sortOrder: number }} input
 * @returns {Promise<object>}
 * @throws {NotFoundError} if the venue doesn't exist
 * @throws {ConflictError} if the venue already has a category with this name
 */
export async function createCategory(venueId, input) {
  await getVenue(venueId); // 404s before we let a stray FK violation surface as a 500

  try {
    return await venuesQueries.insertCategory(pool, { venueId, ...input });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`A category named "${input.name}" already exists for this venue`);
    }
    throw err;
  }
}

/**
 * Expands each row spec into `count` individual seats (rowLabel/seatNumber/gridRow/gridCol),
 * then inserts all of them in one transaction.
 *
 * WHY a transaction for what venues.queries.js already does as a single INSERT statement: none
 * needed for atomicity (unnest() already makes the insert itself all-or-nothing), but every seat
 * referencing a categoryId that must actually belong to THIS venue is not checked here (Phase 2
 * debt — see docs/BUILD_LOG.md) and a future check would need to run in the same transaction as
 * the insert to avoid a race against a category being deleted mid-request. Wrapping now avoids
 * having to revisit the call shape later.
 *
 * @param {string} venueId
 * @param {Array<{ rowLabel: string, count: number, categoryId: string, gridRow: number, startSeatNumber: number, startGridCol: number, isAccessible: boolean }>} rowSpecs
 * @returns {Promise<object[]>} every seat created, camelCased
 * @throws {NotFoundError} if the venue doesn't exist
 * @throws {ConflictError} if any seat's (row_label, seat_number) or (grid_row, grid_col) collides
 *   with an existing seat — including two rows in the same request targeting the same cell
 */
export async function bulkCreateSeats(venueId, rowSpecs) {
  await getVenue(venueId);

  const seats = rowSpecs.flatMap((spec) =>
    Array.from({ length: spec.count }, (_, i) => ({
      categoryId: spec.categoryId,
      rowLabel: spec.rowLabel,
      seatNumber: spec.startSeatNumber + i,
      gridRow: spec.gridRow,
      gridCol: spec.startGridCol + i,
      isAccessible: spec.isAccessible,
    }))
  );

  try {
    return await withTransaction((client) => venuesQueries.insertSeatsBulk(client, venueId, seats));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ConflictError(
        'One or more seats collide with an existing seat number or grid position'
      );
    }
    throw err;
  }
}

/**
 * @param {string} venueId
 * @returns {Promise<{ venue: object, categories: object[], seats: object[] }>}
 * @throws {NotFoundError} if the venue doesn't exist
 */
export async function getVenueLayout(venueId) {
  const venue = await getVenue(venueId);
  const [categories, seats] = await Promise.all([
    venuesQueries.listCategoriesByVenue(pool, venueId),
    venuesQueries.listSeatsByVenue(pool, venueId),
  ]);
  return { venue, categories, seats };
}
