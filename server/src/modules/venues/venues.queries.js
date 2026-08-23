/**
 * venues.queries.js
 *
 * Owns the raw SQL for venues, seat_categories, and seats, plus the snake_case (SQL) <->
 * camelCase (JS) mapping at this boundary.
 *
 * Does NOT own: request validation (shared/schemas/venue.schema.js) or authorization
 * (venues.routes.js's requireRole chain — venue management is role-gated, not ownership-gated;
 * there is no "venue owner" concept, only ADMIN).
 *
 * Invariant: every function here takes a `client`. Never call `pool.query` inside a
 * transaction — see withTransaction.js's header for why that silently breaks correctness.
 */

function mapVenueRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    layoutMeta: row.layout_meta,
    createdAt: row.created_at,
  };
}

function mapCategoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    venueId: row.venue_id,
    name: row.name,
    colorHex: row.color_hex,
    sortOrder: row.sort_order,
  };
}

function mapSeatRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    venueId: row.venue_id,
    categoryId: row.category_id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    gridRow: row.grid_row,
    gridCol: row.grid_col,
    isAccessible: row.is_accessible,
    isActive: row.is_active,
  };
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ name: string, address: string, city: string, layoutMeta: object }} params
 * @returns {Promise<object>} the created venue, camelCased
 */
export async function insertVenue(client, { name, address, city, layoutMeta }) {
  const result = await client.query(
    `INSERT INTO venues (name, address, city, layout_meta)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, address, city, layout_meta, created_at`,
    [name, address, city, layoutMeta]
  );
  return mapVenueRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @returns {Promise<object[]>} every venue, camelCased
 */
export async function listVenues(client) {
  const result = await client.query(`SELECT * FROM venues ORDER BY created_at DESC`);
  return result.rows.map(mapVenueRow);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findVenueById(client, id) {
  const result = await client.query(`SELECT * FROM venues WHERE id = $1`, [id]);
  return mapVenueRow(result.rows[0]);
}

/**
 * Caller must catch a `23505` (unique_violation) on `(venue_id, name)` and translate it to
 * ConflictError — see venues.service.js.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ venueId: string, name: string, colorHex: string | undefined, sortOrder: number }} params
 * @returns {Promise<object>} the created category, camelCased
 */
export async function insertCategory(client, { venueId, name, colorHex, sortOrder }) {
  // WHY COALESCE($3, '#6366f1') instead of letting the column's own DEFAULT apply: `DEFAULT`
  // isn't a value expression Postgres accepts inside COALESCE — it only works as a bare token in
  // a VALUES list. Repeating the literal here (it must match seat_categories' column default,
  // 001_init.sql) is simpler than building the INSERT's column list conditionally.
  const result = await client.query(
    `INSERT INTO seat_categories (venue_id, name, color_hex, sort_order)
     VALUES ($1, $2, COALESCE($3, '#6366f1'), $4)
     RETURNING id, venue_id, name, color_hex, sort_order`,
    [venueId, name, colorHex ?? null, sortOrder]
  );
  return mapCategoryRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} venueId
 * @returns {Promise<object[]>} categories, camelCased, ordered for display
 */
export async function listCategoriesByVenue(client, venueId) {
  const result = await client.query(
    `SELECT * FROM seat_categories WHERE venue_id = $1 ORDER BY sort_order, name`,
    [venueId]
  );
  return result.rows.map(mapCategoryRow);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findCategoryById(client, id) {
  const result = await client.query(`SELECT * FROM seat_categories WHERE id = $1`, [id]);
  return mapCategoryRow(result.rows[0]);
}

/**
 * Inserts every seat in one statement via `unnest()` over parallel arrays, rather than one
 * `INSERT` per seat or a hand-built multi-row `VALUES` list. Single round-trip regardless of how
 * many seats a bulk request expands into, and the parameter count stays fixed at 7 no matter the
 * seat count — a hand-built `VALUES (...), (...), ...` list would need one placeholder per cell.
 *
 * Caller must catch a `23505` (unique_violation) on `(venue_id, row_label, seat_number)` or
 * `(venue_id, grid_row, grid_col)` and translate it to ConflictError — see venues.service.js.
 * This function does not pre-validate for duplicate grid coordinates across rows in the same
 * request; the DB constraint is the source of truth. See "Phase 2 debt" in docs/BUILD_LOG.md.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} venueId
 * @param {Array<{ categoryId: string, rowLabel: string, seatNumber: number, gridRow: number, gridCol: number, isAccessible: boolean }>} seats
 * @returns {Promise<object[]>} the created seats, camelCased
 */
export async function insertSeatsBulk(client, venueId, seats) {
  const result = await client.query(
    `INSERT INTO seats (venue_id, category_id, row_label, seat_number, grid_row, grid_col, is_accessible)
     SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::int[], $5::int[], $6::int[], $7::bool[])
       AS t(category_id, row_label, seat_number, grid_row, grid_col, is_accessible)
     RETURNING id, venue_id, category_id, row_label, seat_number, grid_row, grid_col, is_accessible, is_active`,
    [
      venueId,
      seats.map((s) => s.categoryId),
      seats.map((s) => s.rowLabel),
      seats.map((s) => s.seatNumber),
      seats.map((s) => s.gridRow),
      seats.map((s) => s.gridCol),
      seats.map((s) => s.isAccessible),
    ]
  );
  return result.rows.map(mapSeatRow);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} venueId
 * @returns {Promise<object[]>} active seats, camelCased, grid-ordered
 */
export async function listSeatsByVenue(client, venueId) {
  const result = await client.query(
    `SELECT * FROM seats WHERE venue_id = $1 AND is_active = true ORDER BY grid_row, grid_col`,
    [venueId]
  );
  return result.rows.map(mapSeatRow);
}
