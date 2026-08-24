/**
 * concurrency.test.js
 *
 * Owns the headline concurrency proof suite (docs/PROJECT_PROMPT.md §6.6) against the real
 * Supertest-mounted app and the real `ticket_booking_test` database -- never a mocked pool, since
 * a mock has no row locks and a mocked race test would prove nothing (CLAUDE.md).
 *
 * Covers the three of §6.6's six scenarios that are buildable with what exists through P3-4
 * (holds only -- no bookings module yet, no waitlist/offers module yet):
 *   - 50 parallel POST /holds for one seat -> exactly one winner
 *   - Overlapping multi-seat holds {A1,A2} vs {A2,A3} -> exactly one full winner, the other holds
 *     zero seats
 *   - A public POST /holds against an OFFER_RESERVED seat whose current attempt's expires_at has
 *     lapsed but whose reserved_until has not (Decisions Ledger D-14) -> 409, seat stays
 *     OFFER_RESERVED
 *
 * The other three of §6.6's scenarios need modules this phase doesn't build yet and are tracked,
 * not silently dropped -- see docs/BUILD_LOG.md's P3-9 row and the Phase 3 debt section:
 *   - 20 parallel confirms of one hold -> tests/e2e/bookingFlow.test.js (Phase 4)
 *   - Confirm at expires_at+1ms -> tests/e2e/bookingFlow.test.js (Phase 4)
 *   - 10 waitlisted users racing one offer -> tests/e2e/waitlist.test.js (Phase 5)
 *
 * Does NOT own: the lazy-expiry / "seatmap still reports AVAILABLE with zero workers running"
 * proof -- that's tests/e2e/holdExpiry.test.js, a distinct mechanism (Layer 1 alone) from the
 * races proven here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { migrateTestDb, truncateAllTables, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, buildBookableShow } from '../setup/fixtures.js';

beforeAll(async () => {
  await migrateTestDb();
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});

describe('concurrency: 50 parallel holds on one seat', () => {
  it('exactly one 201, the rest 409, and the DB agrees', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 2 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);

    const RACERS = 50;
    const responses = await Promise.all(
      Array.from({ length: RACERS }, () =>
        request(app)
          .post('/api/v1/holds')
          .set('Cookie', cookie)
          .send({ showId, seatIds: [seatId] })
      )
    );

    const wins = responses.filter((res) => res.status === 201);
    const losses = responses.filter((res) => res.status === 409);

    // The literal §6.6 assertion: exactly one winner, never "at least one" -- a flaky "at least
    // one" assertion would still pass if the acquire predicate somehow let two through.
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(RACERS - 1);
    for (const loss of losses) {
      expect(loss.body.error.code).toBe('SEATS_UNAVAILABLE');
    }

    const { rows } = await pool.query(
      `SELECT state, hold_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('HELD');
    expect(rows[0].hold_id).toBe(wins[0].body.data.hold.id);

    const heldCount = await pool.query(
      `SELECT count(*)::int AS n FROM show_seats WHERE show_id = $1 AND state = 'HELD'`,
      [showId]
    );
    expect(heldCount.rows[0].n).toBe(1);
  });
});

describe('concurrency: overlapping multi-seat holds', () => {
  it('{A1,A2} vs {A2,A3} racing on A2 -> one full winner, the other holds zero seats', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 3 });
    const { cookie: cookieA } = await registerAndLogin(app);
    const { cookie: cookieB } = await registerAndLogin(app);

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/v1/holds')
        .set('Cookie', cookieA)
        .send({ showId, seatIds: [seatIdByLabel.A1, seatIdByLabel.A2] }),
      request(app)
        .post('/api/v1/holds')
        .set('Cookie', cookieB)
        .send({ showId, seatIds: [seatIdByLabel.A2, seatIdByLabel.A3] }),
    ]);

    const results = [resA, resB];
    const winners = results.filter((res) => res.status === 201);
    const losers = results.filter((res) => res.status === 409);

    // Neither request could deadlock or both fail -- exactly one request gets everything it
    // asked for, and the SAME statement's ORDER BY seat_id lock ordering (holds.queries.js) is
    // why this doesn't even need a retry to resolve cleanly.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser's own conflicting-seats list names A2 -- the only seat it was ever actually
    // racing anyone for -- never A1 or A3, which nobody else touched.
    const conflictingLabels = losers[0].body.error.details.conflictingSeats.map(
      (seat) => `${seat.rowLabel}${seat.seatNumber}`
    );
    expect(conflictingLabels).toEqual(['A2']);

    // "The loser holds zero seats" (§6.6) is a claim about the PARENT seat_holds row, not just
    // show_seats -- holds.service.js#createHold's shortfall rollback (Decisions Ledger D-35) is
    // what makes this true; acquireSeats() alone can return a genuinely partial array for the
    // loser (it may still win whichever seat wasn't contested). Only one seat_holds row should
    // exist at all: the winner's.
    const activeHolds = await pool.query(
      `SELECT count(*)::int AS n FROM seat_holds WHERE show_id = $1 AND status = 'ACTIVE'`,
      [showId]
    );
    expect(activeHolds.rows[0].n).toBe(1);

    const seatStates = await pool.query(
      `SELECT s.row_label, s.seat_number, ss.state
         FROM show_seats ss JOIN seats s ON s.id = ss.seat_id
        WHERE ss.show_id = $1
        ORDER BY s.seat_number`,
      [showId]
    );
    const stateByLabel = Object.fromEntries(
      seatStates.rows.map((row) => [`${row.row_label}${row.seat_number}`, row.state])
    );

    // Exactly one of the two valid final configurations -- never a third, inconsistent one where
    // e.g. A2 ends up HELD but neither A1 nor A3 does, or where both racers got A2.
    const userAWon = stateByLabel.A1 === 'HELD' && stateByLabel.A2 === 'HELD';
    const userBWon = stateByLabel.A2 === 'HELD' && stateByLabel.A3 === 'HELD';
    expect(userAWon !== userBWon).toBe(true);
    expect(stateByLabel[userAWon ? 'A3' : 'A1']).toBe('AVAILABLE');
  });
});

describe('concurrency: OFFER_RESERVED seat vs. a public hold (Decisions Ledger D-14)', () => {
  it('reserved_until in the future keeps the seat unacquirable even past expires_at', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;

    // No waitlist/offers module exists yet (that's Phase 5) -- this reaches into show_seats
    // directly to construct the exact state a live cascade would be in mid-window: the CURRENT
    // offer attempt's deadline (expires_at) has already lapsed, but the whole cascade's outer
    // bound (reserved_until) has not. This is the literal scenario D-14 exists to cover: without
    // it, a public hold could snipe the seat between one offeree's lapsed attempt and the next
    // person in line actually being offered it.
    await pool.query(
      `UPDATE show_seats
          SET state = 'OFFER_RESERVED',
              expires_at = now() - interval '1 minute',
              reserved_until = now() + interval '1 hour'
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );

    const { cookie } = await registerAndLogin(app);
    const res = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookie)
      .send({ showId, seatIds: [seatId] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');

    const { rows } = await pool.query(
      `SELECT state, expires_at, reserved_until FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    // Untouched, not "reclaimed then re-set" -- acquireSeats()'s WHERE clause simply never
    // matched this row, so nothing about it should have changed at all.
    expect(rows[0].state).toBe('OFFER_RESERVED');
    expect(rows[0].reserved_until).not.toBeNull();
  });
});
