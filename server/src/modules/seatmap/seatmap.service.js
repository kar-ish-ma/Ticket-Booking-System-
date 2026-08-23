/**
 * seatmap.service.js
 *
 * Owns shaping the effective seat-map read into what the client needs: the flat per-seat grid
 * plus a legend (one entry per category actually present, with its colour and price) derived
 * from the same rows rather than a second query.
 *
 * Does NOT own: the effective-state SQL itself (seatmap.queries.js).
 */

import { pool } from '../../db/pool.js';
import { NotFoundError } from '../../utils/errors.js';
import * as seatmapQueries from './seatmap.queries.js';
import * as showsQueries from '../shows/shows.queries.js';

/**
 * @param {string} showId
 * @returns {Promise<{ showId: string, seats: object[], legend: object[] }>}
 * @throws {NotFoundError} if no show has this id
 */
export async function getSeatMap(showId) {
  const show = await showsQueries.findShowById(pool, showId);
  if (!show) throw new NotFoundError('Show not found');

  const seats = await seatmapQueries.getEffectiveSeatMap(pool, showId);

  // WHY a Map keyed by categoryId instead of a second SELECT DISTINCT ... FROM seat_categories:
  // the seat rows already carry every category's name/colour/price — a show not yet published
  // (zero show_seats rows, P2-6) legitimately has an empty legend too, which a separate
  // "categories for this venue" query would get wrong by returning categories that aren't
  // actually priced or seated for this show yet.
  const legendByCategory = new Map();
  for (const seat of seats) {
    if (!legendByCategory.has(seat.categoryId)) {
      legendByCategory.set(seat.categoryId, {
        categoryId: seat.categoryId,
        name: seat.categoryName,
        colorHex: seat.categoryColorHex,
        priceCents: seat.priceCents,
      });
    }
  }

  return { showId, seats, legend: Array.from(legendByCategory.values()) };
}
