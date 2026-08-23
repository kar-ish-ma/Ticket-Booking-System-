/**
 * events.queries.js
 *
 * Owns the raw SQL for events, including the public browse query, and the snake_case (SQL) <->
 * camelCase (JS) mapping at this boundary.
 *
 * Does NOT own: request validation (shared/schemas/event.schema.js), ownership authorization
 * (requireOwnership.js, wired in events.routes.js), or anything about shows (shows.queries.js).
 *
 * Invariant: every function here takes a `client`. Never call `pool.query` inside a
 * transaction — see withTransaction.js's header for why that silently breaks correctness.
 */

// serves: GET /events pagination — kept fixed rather than client-controlled, so a caller can't
// request an unbounded page size against a 4GB dev machine.
const PAGE_SIZE = 20;

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    organiserId: row.organiser_id,
    title: row.title,
    type: row.type,
    description: row.description,
    posterUrl: row.poster_url,
    language: row.language,
    genre: row.genre,
    durationMin: row.duration_min,
    isPublished: row.is_published,
    createdAt: row.created_at,
  };
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ organiserId: string, title: string, type: string, description: string, posterUrl: string | undefined, language: string | undefined, genre: string | undefined, durationMin: number }} params
 * @returns {Promise<object>} the created event, camelCased
 */
export async function insertEvent(
  client,
  { organiserId, title, type, description, posterUrl, language, genre, durationMin }
) {
  const result = await client.query(
    `INSERT INTO events (organiser_id, title, type, description, poster_url, language, genre, duration_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      organiserId,
      title,
      type,
      description,
      posterUrl ?? null,
      language ?? null,
      genre ?? null,
      durationMin,
    ]
  );
  return mapEventRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findEventById(client, id) {
  const result = await client.query(`SELECT * FROM events WHERE id = $1`, [id]);
  return mapEventRow(result.rows[0]);
}

// snake_case column each patchable field maps to, in the same order updateEvent's camelCase
// input keys are checked below — keeping the two lists side by side is what makes it obvious if
// one is edited without the other.
const PATCHABLE_COLUMNS = {
  title: 'title',
  type: 'type',
  description: 'description',
  posterUrl: 'poster_url',
  language: 'language',
  genre: 'genre',
  durationMin: 'duration_min',
  isPublished: 'is_published',
};

/**
 * Builds its SET clause from whichever keys are actually present in `patch` — PATCH semantics,
 * not PUT. An empty patch (caller sent `{}`) is a no-op read, not an error: it just returns the
 * event unchanged rather than issuing a SQL statement with an empty SET list.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} id
 * @param {object} patch - camelCase keys from updateEventSchema; only present keys are applied
 * @returns {Promise<object | null>} the updated event, camelCased, or null if no event has this id
 */
export async function updateEvent(client, id, patch) {
  const entries = Object.entries(patch).filter(([key]) => key in PATCHABLE_COLUMNS);
  if (entries.length === 0) {
    return findEventById(client, id);
  }

  const setClauses = entries.map(([key], i) => `${PATCHABLE_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([, value]) => value);

  const result = await client.query(
    `UPDATE events SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return mapEventRow(result.rows[0]);
}

/**
 * Public browse. Every filter is optional — an unset filter is a no-op via the
 * `$n::type IS NULL OR ...` pattern, so one query serves every combination of filters instead of
 * building the WHERE clause conditionally in JS.
 *
 * WHY the EXISTS subquery for city/dateFrom/dateTo rather than a JOIN: an event can have many
 * shows across many venues. A JOIN would duplicate the event row once per matching show and need
 * a DISTINCT; EXISTS asks "does at least one show satisfy this" without ever producing duplicate
 * rows, which also means COUNT(*) OVER() (for `total`) stays correct without a separate
 * COUNT DISTINCT query.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ type: string | undefined, city: string | undefined, dateFrom: Date | undefined, dateTo: Date | undefined, q: string | undefined, page: number }} filters
 * @returns {Promise<{ events: object[], total: number, page: number, pageSize: number }>}
 */
export async function listPublishedEvents(client, { type, city, dateFrom, dateTo, q, page }) {
  const result = await client.query(
    `SELECT e.*, COUNT(*) OVER () AS total_count
       FROM events e
      WHERE e.is_published = true
        AND ($1::event_type_t IS NULL OR e.type = $1)
        AND ($2::text IS NULL OR e.title ILIKE '%' || $2 || '%')
        AND (
          ($3::text IS NULL AND $4::timestamptz IS NULL AND $5::timestamptz IS NULL)
          OR EXISTS (
            SELECT 1 FROM shows s
              JOIN venues v ON v.id = s.venue_id
             WHERE s.event_id = e.id
               AND s.status = 'SCHEDULED'
               AND ($3::text IS NULL OR v.city ILIKE $3)
               AND ($4::timestamptz IS NULL OR s.starts_at >= $4)
               AND ($5::timestamptz IS NULL OR s.starts_at <= $5)
          )
        )
      ORDER BY e.created_at DESC
      LIMIT $6 OFFSET $7`,
    [type ?? null, q ?? null, city ?? null, dateFrom ?? null, dateTo ?? null, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );

  return {
    events: result.rows.map(mapEventRow),
    total: result.rows[0] ? Number(result.rows[0].total_count) : 0,
    page,
    pageSize: PAGE_SIZE,
  };
}
