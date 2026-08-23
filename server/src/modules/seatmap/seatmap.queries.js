/**
 * seatmap.queries.js
 *
 * Owns the one query that makes lazy expiry real: reading show_seats and deciding each row's
 * *effective* state, not just its stored one. This file's CASE expression IS Layer 1 of the
 * three-layer TTL design (docs/PROJECT_PROMPT.md §5.2) — the scheduler that ships in Phase 3
 * only ever materialises what this predicate already treats as true.
 *
 * Does NOT own: writing to show_seats (that's holds.queries.js, Phase 3) or deciding whether a
 * requested state transition is legal (seatState.machine.js, also Phase 3 — this file only
 * reads).
 *
 * Invariant: every function here takes a `client`.
 */

// WHY this CASE expression, not a WHERE-clause filter or an application-side check:
// docs/PROJECT_PROMPT.md §5.1's core principle — "a hold is expired because the clock says so,
// not because a job said so" — has to hold on every read, and Phase 3 doesn't exist yet to have
// already flipped a stale HELD/OFFER_RESERVED row back to AVAILABLE. Computing it here means the
// seatmap is honest even against a show_seats row nobody has touched since a TTL lapsed, with
// zero workers involved. OFFER_RESERVED checks reserved_until, not expires_at, for the same
// reason holds.queries.js's acquire predicate will (Decisions Ledger D-14): expires_at is only
// the current cascade attempt's deadline, and a seat must stay off the public map for the whole
// cascade window, not just until one attempt lapses.
const EFFECTIVE_STATE_CASE = `
  CASE
    WHEN ss.state = 'HELD' AND ss.expires_at <= now() THEN 'AVAILABLE'
    WHEN ss.state = 'OFFER_RESERVED' AND ss.reserved_until <= now() THEN 'AVAILABLE'
    ELSE ss.state
  END
`;

function mapSeatMapRow(row) {
  return {
    showSeatId: row.show_seat_id,
    seatId: row.seat_id,
    categoryId: row.category_id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    gridRow: row.grid_row,
    gridCol: row.grid_col,
    isAccessible: row.is_accessible,
    state: row.effective_state,
    categoryName: row.category_name,
    categoryColorHex: row.category_color_hex,
    priceCents: row.price_cents,
  };
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} showId
 * @returns {Promise<object[]>} one row per show_seat, camelCased, with `state` already resolved
 *   to its effective value — never the raw stored one
 */
export async function getEffectiveSeatMap(client, showId) {
  const result = await client.query(
    `SELECT ss.id AS show_seat_id, ss.seat_id, ss.category_id,
            s.row_label, s.seat_number, s.grid_row, s.grid_col, s.is_accessible,
            ${EFFECTIVE_STATE_CASE} AS effective_state,
            sc.name AS category_name, sc.color_hex AS category_color_hex,
            sp.price_cents
       FROM show_seats ss
       JOIN seats s ON s.id = ss.seat_id
       JOIN seat_categories sc ON sc.id = ss.category_id
       LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
      WHERE ss.show_id = $1
      ORDER BY s.grid_row, s.grid_col`,
    [showId]
  );
  return result.rows.map(mapSeatMapRow);
}
