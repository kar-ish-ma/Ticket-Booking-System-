/**
 * holds.queries.js
 *
 * Owns the raw SQL for seat acquisition AND release — acquireSeats() is the single most
 * important thing in the codebase; everything else here exists to support it or its inverse:
 * creating/looking up the parent `seat_holds` row, and releasing a hold's seats back to
 * AVAILABLE.
 *
 * Does NOT own: hold orchestration (deciding whether a short acquireSeats() result is acceptable
 * or must be rolled back; deciding whether a release is idempotent; TTL job-queue registration
 * P3-5; socket broadcasting P3-6 — all holds.service.js). This file does not decide what
 * "all-or-nothing" or "idempotent" mean at the service layer — see acquireSeats()'s and
 * releaseHold()'s own doc comments for exactly what each layer's contract does and doesn't
 * guarantee.
 *
 * Invariant: every write function here takes a `client` that must already be inside a
 * transaction (see withTransaction.js's header for why calling `pool.query` here instead would
 * silently escape that transaction). `findSeatHoldById` is the one read-only exception — it
 * accepts a bare `pool` too, for callers with no transaction open yet (e.g.
 * holds.service.js#loadHoldForOwnership, running from route middleware before any transaction
 * exists), matching the same `PoolClient | Pool` pattern venues.queries.js and events.queries.js
 * already use for their own read-only lookups. The atomic acquire stays ONE SQL statement,
 * always. If this file grows further, extract *around* the acquire query — never split it into a
 * read then a write. That split is the exact bug this entire design exists to prevent (CLAUDE.md).
 */

/**
 * WALKTHROUGH: acquireSeats(), and what the loser of a race experiences
 *
 * 1. The CTE takes a `FOR UPDATE` row lock on every requested show_seats row, in `seat_id`
 *    order — not in the order the caller listed them. Two overlapping requests, say {A1,A2}
 *    and {A2,A3}, both resolve their lock order the same way (alphabetically A1 < A2 < A3), so
 *    both transactions always try to lock A2 before A3. They queue behind each other on the
 *    contended row instead of each holding a lock the other one wants — which is exactly what a
 *    deadlock is. A two-seat race on a single shared seat can never exercise this at all; only
 *    an overlapping MULTI-seat race can, which is why it gets its own proof in docs/TESTING.md
 *    rather than waiting for P3-9's headline suite.
 * 2. The CTE runs to completion — including waiting out any lock it's blocked on — before the
 *    outer UPDATE evaluates a single predicate. So by the time the predicate runs, every
 *    candidate row this transaction asked for is already locked; nothing it looks at can change
 *    underneath it mid-statement.
 * 3. The outer UPDATE's WHERE clause re-reads each row's CURRENT state — not whatever it looked
 *    like before the lock wait — against three OR'd branches: AVAILABLE; HELD but its own TTL
 *    has lapsed (`expires_at <= now()` — Layer 1 of the TTL design, docs/PROJECT_PROMPT.md
 *    §5.1); or OFFER_RESERVED whose entire cascade window has lapsed (`reserved_until <= now()`,
 *    NOT `expires_at` — Decisions Ledger D-14. `expires_at` on an OFFER_RESERVED row is only the
 *    CURRENT cascade attempt's deadline; checking it here would let a public hold snipe a seat
 *    mid-cascade, before the next waitlisted person has even been offered it).
 * 4. Every row that matches gets flipped to HELD under this holdId/userId, RETURNING its
 *    seat_id. `reserved_until` is explicitly cleared — a seat reclaimed out of OFFER_RESERVED
 *    has no cascade window anymore, and leaving a stale value there would be read by nothing but
 *    would still be a lie sitting in the row.
 * 5. What the loser of a SINGLE-seat race experiences: two customers request the same one seat.
 *    Whichever transaction's outer UPDATE runs second re-evaluates the predicate against the
 *    now-current row — freshly HELD, not expired — so neither OR branch matches. Its RETURNING
 *    set is empty. No exception, no deadlock, no special-cased error path: an empty array IS
 *    the "you lost" signal.
 * 6. What the loser of an OVERLAPPING multi-seat race experiences — and the one genuinely
 *    counter-intuitive part of this function's contract: it is NOT necessarily an empty array.
 *    {A1,A2} vs {A2,A3} both want A2; only one of them can have it. But A1 and A3 were never
 *    contested — whichever transaction loses A2 still, independently, wins the seat it wasn't
 *    racing anyone for. Its RETURNING set comes back as a PARTIAL array (just the uncontested
 *    seat), not empty. This function's own contract stops here: it reports exactly which seats
 *    it actually got, and never throws to signal a shortfall (see @throws below). Turning "I got
 *    fewer seats than I asked for" into "roll back and give me zero" is a decision this function
 *    deliberately does not make — that's the caller's job (holds.service.js#createHold, P3-3),
 *    wrapping this call in a transaction and rolling back the whole thing on any shortfall. Only
 *    at THAT layer does "the loser holds zero seats" (docs/PROJECT_PROMPT.md §6.6) become true;
 *    at this layer, the honest claim is narrower: every row this statement touches, it touches
 *    correctly and atomically — nothing here fabricates a false success or a false failure.
 *
 * @param {import('pg').PoolClient} client - must already be inside a transaction
 * @param {{ showId: string, seatIds: string[], holdId: string, userId: string, ttlSeconds: number }} params
 * @returns {Promise<string[]>} seat ids actually held — caller MUST check length against
 *   `seatIds.length` and decide whether a short result is acceptable
 * @throws never; partial success is signalled by a short array, not an exception
 */
export async function acquireSeats(client, { showId, seatIds, holdId, userId, ttlSeconds }) {
  const result = await client.query(
    `WITH candidates AS (
       SELECT id
         FROM show_seats
        WHERE show_id = $1 AND seat_id = ANY($2::uuid[])
        ORDER BY seat_id           -- deterministic lock order => no deadlocks (see WALKTHROUGH #1)
          FOR UPDATE
     )
     UPDATE show_seats s
        SET state = 'HELD',
            hold_id = $3,
            held_by_user_id = $4,
            expires_at = now() + make_interval(secs => $5),
            reserved_until = NULL, -- clears any stale OFFER_RESERVED bound; HELD only ever uses expires_at
            version = s.version + 1,
            updated_at = now()
       FROM candidates c
      WHERE s.id = c.id
        AND ( s.state = 'AVAILABLE'
           OR (s.state = 'HELD'           AND s.expires_at     <= now())
           OR (s.state = 'OFFER_RESERVED' AND s.reserved_until <= now()) )
     RETURNING s.seat_id`,
    [showId, seatIds, holdId, userId, ttlSeconds]
  );

  return result.rows.map((row) => row.seat_id);
}

/**
 * Creates the parent `seat_holds` row a hold's `show_seats.hold_id` references. Must run in the
 * SAME transaction as the acquireSeats() call it precedes — if that transaction later rolls back
 * (see holds.service.js#createHold's shortfall check), this row is undone along with everything
 * else, never left orphaned as an ACTIVE hold owning zero seats.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ showId: string, userId: string, ttlSeconds: number }} params
 * @returns {Promise<{ id: string, expiresAt: Date }>}
 */
export async function insertSeatHold(client, { showId, userId, ttlSeconds }) {
  const result = await client.query(
    `INSERT INTO seat_holds (show_id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id, expires_at`,
    [showId, userId, ttlSeconds]
  );
  return { id: result.rows[0].id, expiresAt: result.rows[0].expires_at };
}

/**
 * Looks up row_label/seat_number for a set of seat ids — used to turn the seats acquireSeats()
 * couldn't get into a human-readable conflicting-seats list for SeatsUnavailableError
 * (docs/PROJECT_PROMPT.md §6.1: "return 409 SEATS_UNAVAILABLE with the conflicting seat labels
 * so the UI can flash them red").
 *
 * @param {import('pg').PoolClient} client
 * @param {string} showId
 * @param {string[]} seatIds
 * @returns {Promise<Array<{ seatId: string, rowLabel: string, seatNumber: number }>>}
 */
export async function findSeatLabels(client, showId, seatIds) {
  const result = await client.query(
    `SELECT s.id AS seat_id, s.row_label, s.seat_number
       FROM seats s
       JOIN show_seats ss ON ss.seat_id = s.id
      WHERE ss.show_id = $1 AND s.id = ANY($2::uuid[])`,
    [showId, seatIds]
  );
  return result.rows.map((row) => ({
    seatId: row.seat_id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
  }));
}

/**
 * Frees every show_seats row still governed by this hold. Keyed on `hold_id = $1 AND state =
 * 'HELD'`, not on the seats this hold originally acquired — see
 * holds.service.js#releaseHold's WALKTHROUGH for why that's what makes a release of a STALE
 * holdId safe against clobbering a seat that's since been reclaimed under a different hold.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} holdId
 * @returns {Promise<string[]>} seat ids actually released — 0 rows is the normal outcome for an
 *   already-released or superseded hold, never an error condition
 */
export async function releaseHoldSeats(client, holdId) {
  const result = await client.query(
    `UPDATE show_seats
        SET state = 'AVAILABLE', hold_id = NULL, held_by_user_id = NULL,
            expires_at = NULL, version = version + 1, updated_at = now()
      WHERE hold_id = $1 AND state = 'HELD'
     RETURNING seat_id`,
    [holdId]
  );
  return result.rows.map((row) => row.seat_id);
}

/**
 * Marks the `seat_holds` row itself terminal. Keyed on `id = $1` — this row's OWN primary key,
 * never on which seats it governs — so this can only ever touch hold `$1`'s own bookkeeping row,
 * regardless of what releaseHoldSeats() above did or didn't find. `status = 'ACTIVE'` in the
 * WHERE clause is what makes a second call a no-op instead of re-writing an already-terminal row.
 *
 * WHY this function's name still says "Released" even though `'CONVERTED'` (P4-2,
 * bookings.service.js#confirmBooking) is also a legal `status` here: the SQL is identical for all
 * three terminal outcomes (`id = $1 AND status = 'ACTIVE'`), and reusing one function under its
 * original name beat duplicating the same query under a second name just to keep the name
 * perfectly literal — a call site reads `markSeatHoldReleased(client, holdId, 'CONVERTED')`, which
 * is legible enough in context (a hold ending because it became a booking is still, in every
 * sense that matters to this row, a release of the hold's own claim).
 *
 * @param {import('pg').PoolClient} client
 * @param {string} holdId
 * @param {'RELEASED' | 'EXPIRED' | 'CONVERTED'} status
 * @returns {Promise<boolean>} true if this call is what transitioned the row (false on a
 *   second/idempotent call, or a holdId that never existed)
 */
export async function markSeatHoldReleased(client, holdId, status) {
  const result = await client.query(
    `UPDATE seat_holds SET status = $2 WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
    [holdId, status]
  );
  return result.rowCount > 0;
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} holdId
 * @returns {Promise<{ id: string, showId: string, userId: string, status: string, expiresAt: Date } | null>}
 */
export async function findSeatHoldById(client, holdId) {
  const result = await client.query(`SELECT * FROM seat_holds WHERE id = $1`, [holdId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    showId: row.show_id,
    userId: row.user_id,
    status: row.status,
    expiresAt: row.expires_at,
  };
}
