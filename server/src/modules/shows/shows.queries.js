/**
 * shows.queries.js
 *
 * Owns the raw SQL for shows, show_prices, and — the one function every later phase builds on —
 * materialising show_seats from a venue's seat layout (§4's "THE critical table").
 *
 * Does NOT own: request validation (shared/schemas/event.schema.js), ownership authorization
 * (requireOwnership.js, wired in shows.routes.js), or seat map reads (seatmap.queries.js).
 *
 * Invariant: every function here takes a `client`. Never call `pool.query` inside a
 * transaction — see withTransaction.js's header for why that silently breaks correctness.
 */

function mapShowRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    venueId: row.venue_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    holdTtlSeconds: row.hold_ttl_seconds,
    offerTtlSeconds: row.offer_ttl_seconds,
  };
}

function mapShowPriceRow(row) {
  if (!row) return null;
  return { showId: row.show_id, categoryId: row.category_id, priceCents: row.price_cents };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ eventId: string, venueId: string, startsAt: Date, endsAt: Date, holdTtlSeconds: number | undefined, offerTtlSeconds: number | undefined }} params
 * @returns {Promise<object>} the created show, camelCased
 */
export async function insertShow(
  client,
  { eventId, venueId, startsAt, endsAt, holdTtlSeconds, offerTtlSeconds }
) {
  // WHY the literal fallbacks (600 / 900) instead of `COALESCE($n, DEFAULT)`: same reason as
  // venues.queries.js#insertCategory's colour default — `DEFAULT` is only a valid bare token in a
  // VALUES list, not a value expression COALESCE can take as an argument, and Postgres rejects it
  // (`42601`, found live running this exact statement). These two literals must stay in sync with
  // shows.hold_ttl_seconds / shows.offer_ttl_seconds's own column defaults (002_events_shows.sql).
  const result = await client.query(
    `INSERT INTO shows (event_id, venue_id, starts_at, ends_at, hold_ttl_seconds, offer_ttl_seconds)
     VALUES ($1, $2, $3, $4, COALESCE($5, 600), COALESCE($6, 900))
     RETURNING *`,
    [eventId, venueId, startsAt, endsAt, holdTtlSeconds ?? null, offerTtlSeconds ?? null]
  );
  return mapShowRow(result.rows[0]);
}

/**
 * Same `unnest()`-over-parallel-arrays shape as venues.queries.js#insertSeatsBulk — one round
 * trip, one all-or-nothing statement, regardless of how many categories the show prices.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} showId
 * @param {Array<{ categoryId: string, priceCents: number }>} prices
 * @returns {Promise<object[]>} the created price rows, camelCased
 */
export async function insertShowPrices(client, showId, prices) {
  const result = await client.query(
    `INSERT INTO show_prices (show_id, category_id, price_cents)
     SELECT $1, * FROM unnest($2::uuid[], $3::int[]) AS t(category_id, price_cents)
     RETURNING *`,
    [showId, prices.map((p) => p.categoryId), prices.map((p) => p.priceCents)]
  );
  return result.rows.map(mapShowPriceRow);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findShowById(client, id) {
  const result = await client.query(`SELECT * FROM shows WHERE id = $1`, [id]);
  return mapShowRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} showId
 * @returns {Promise<object[]>}
 */
export async function listShowPrices(client, showId) {
  const result = await client.query(`SELECT * FROM show_prices WHERE show_id = $1`, [showId]);
  return result.rows.map(mapShowPriceRow);
}

/**
 * The public show-detail read: the show itself plus its parent event's title/type and its
 * venue's name/city, flattened into one row rather than three round trips. GET /shows/:id is a
 * hot, unauthenticated path (every customer hits it before booking) — one query keeps it cheap.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findShowDetailById(client, id) {
  const result = await client.query(
    `SELECT s.*,
            e.title AS event_title, e.type AS event_type, e.poster_url AS event_poster_url,
            v.name AS venue_name, v.city AS venue_city, v.address AS venue_address
       FROM shows s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = s.venue_id
      WHERE s.id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    ...mapShowRow(row),
    event: { id: row.event_id, title: row.event_title, type: row.event_type, posterUrl: row.event_poster_url },
    venue: { id: row.venue_id, name: row.venue_name, city: row.venue_city, address: row.venue_address },
  };
}

/**
 * requireOwnership.js's loader shape needs the OWNING organiser, which lives on `events`, not
 * `shows` — this is the one join query that bridges the two, used only for the publish route's
 * ownership check (shows.service.js#loadShowForOwnership).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} showId
 * @returns {Promise<{ id: string, eventId: string, organiserId: string, venueId: string } | null>}
 */
export async function findShowWithEventOwner(client, showId) {
  const result = await client.query(
    `SELECT s.id, s.event_id, s.venue_id, e.organiser_id
       FROM shows s JOIN events e ON e.id = s.event_id
      WHERE s.id = $1`,
    [showId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, eventId: row.event_id, venueId: row.venue_id, organiserId: row.organiser_id };
}

/**
 * The public "which showtimes does this event have" read — client/index.html's event-detail
 * screen needs this to get from an event to a bookable showId; nothing else in this codebase
 * lists shows by event (GET /shows/:id only ever takes a single already-known showId).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} eventId
 * @returns {Promise<object[]>} shows, camelCased, soonest first, each with its venue's name/city
 */
export async function listShowsByEvent(client, eventId) {
  const result = await client.query(
    `SELECT s.*, v.name AS venue_name, v.city AS venue_city
       FROM shows s
       JOIN venues v ON v.id = s.venue_id
      WHERE s.event_id = $1
      ORDER BY s.starts_at`,
    [eventId]
  );
  return result.rows.map((row) => ({
    ...mapShowRow(row),
    venue: { id: row.venue_id, name: row.venue_name, city: row.venue_city },
  }));
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} showId
 * @returns {Promise<number>} how many show_seats rows already exist for this show — nonzero
 *   means it's already been published (see shows.service.js#publishShow)
 */
export async function countShowSeats(client, showId) {
  const result = await client.query(`SELECT count(*)::int AS n FROM show_seats WHERE show_id = $1`, [
    showId,
  ]);
  return result.rows[0].n;
}

/**
 * WALKTHROUGH: publishShow()'s materialisation step
 *
 * 1. One `INSERT ... SELECT` copies every active seat the venue has into show_seats, all in the
 *    default AVAILABLE state, with no hold_id/booking_id/expires_at set. This is the moment a
 *    show's seat map — the thing Phase 3's atomic acquire will take row locks on — comes into
 *    existence.
 * 2. It's a single statement: Postgres either inserts every seat or none, so there is no partial
 *    state where a show has 140 of its venue's 200 seats.
 * 3. Nothing here decides whether this is the FIRST publish — shows.service.js#publishShow checks
 *    countShowSeats() first and refuses to call this twice. If it ran a second time anyway, the
 *    `UNIQUE (show_id, seat_id)` constraint (003_show_seats.sql) would reject the duplicate
 *    inserts outright rather than corrupting the seat map.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} showId
 * @param {string} venueId
 * @returns {Promise<number>} how many show_seats rows were created
 */
export async function materialiseShowSeats(client, showId, venueId) {
  const result = await client.query(
    `INSERT INTO show_seats (show_id, seat_id, category_id, state)
     SELECT $1, id, category_id, 'AVAILABLE'
       FROM seats
      WHERE venue_id = $2 AND is_active = true`,
    [showId, venueId]
  );
  return result.rowCount;
}
