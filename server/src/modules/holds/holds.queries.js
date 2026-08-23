/**
 * holds.queries.js
 *
 * Owns the raw SQL for seat acquisition — acquireSeats() is the single most important thing in
 * the codebase, and everything else here exists only to support it: creating the parent
 * `seat_holds` row it references, and looking up seat labels for a 409's conflicting-seats
 * payload.
 *
 * Does NOT own: hold orchestration (deciding whether a short acquireSeats() result is acceptable
 * or must be rolled back, TTL registration, socket broadcasting — holds.service.js, P3-3+). This
 * file does not decide what "all-or-nothing" means at the service layer — see acquireSeats()'s
 * own doc comment and WALKTHROUGH for exactly what its own contract does and doesn't guarantee.
 *
 * Invariant: every function here takes a `client` — it must already be inside a transaction
 * (see withTransaction.js's header for why calling `pool.query` here instead would silently
 * escape that transaction). The atomic acquire stays ONE SQL statement, always. If this file
 * grows further, extract *around* the acquire query — never split it into a read then a write.
 * That split is the exact bug this entire design exists to prevent (CLAUDE.md).
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
