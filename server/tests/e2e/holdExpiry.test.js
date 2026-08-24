/**
 * holdExpiry.test.js
 *
 * Owns the automated proof of docs/PROJECT_PROMPT.md §5.1's core principle: "a hold is expired
 * because the clock says so, not because a job said so." Layers 2 and 3 of the TTL design (the
 * job-queue release, the cron reconciler) are deferred to after Phase 5 (docs/BUILD_LOG.md's
 * Phase 3 table) -- which makes this test, right now, an unusually strong version of itself: there
 * is no scheduler running AT ALL in this codebase yet, so a pass here can only be Layer 1 (the SQL
 * predicate) working, not some other layer masking a broken one.
 *
 * Does NOT own: the acquire-side RACES (tests/e2e/concurrency.test.js) -- who wins when two
 * requests contend for the same seat AT THE SAME TIME. This file's second test is the sibling
 * proof concurrency.test.js doesn't cover: a single, uncontested second request reclaiming a seat
 * whose PREVIOUS hold has lapsed -- Layer 1 acting on the WRITE side, not just the read side.
 * Found missing at the P3-close-phase-3 audit: with only the first test in this file, deleting
 * acquireSeats()'s `(state='HELD' AND expires_at<=now())` OR-branch entirely left the whole e2e
 * suite green -- the phase's own exit criterion ("seats free themselves") had no test that could
 * actually fail if that exact mechanism broke.
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

describe('hold expiry with zero workers running', () => {
  it('a HELD seat past its expires_at reads as AVAILABLE on the seat map', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);

    const holdRes = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookie)
      .send({ showId, seatIds: [seatId] });
    expect(holdRes.status).toBe(201);

    // Manually rewind the clock on this one row, exactly as the P2-7 proof did before Phase 3
    // existed -- there is still no scheduler in this codebase to have flipped it back on its own.
    // A passing test below can only mean the seatmap's own effective-state CASE (Layer 1) did it.
    await pool.query(
      `UPDATE show_seats SET expires_at = now() - interval '1 hour'
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );

    const before = await pool.query(
      `SELECT state, (expires_at <= now()) AS is_past FROM show_seats
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(before.rows[0].state).toBe('HELD');
    expect(before.rows[0].is_past).toBe(true);

    const seatMapRes = await request(app).get(`/api/v1/shows/${showId}/seatmap`);
    expect(seatMapRes.status).toBe(200);
    const seat = seatMapRes.body.data.seats.find((s) => s.seatId === seatId);
    expect(seat.state).toBe('AVAILABLE');

    // And the raw row itself is untouched -- the READ computed the effective state without
    // writing anything back. Materialising the write is Layer 2/3's job, deferred (see header).
    const after = await pool.query(`SELECT state FROM show_seats WHERE show_id = $1 AND seat_id = $2`, [
      showId,
      seatId,
    ]);
    expect(after.rows[0].state).toBe('HELD');
  });
});

describe('hold expiry: the write side -- a lapsed HELD seat can be reclaimed by a new hold', () => {
  it('a second POST /holds from a different user succeeds once expires_at has passed, and takes over the seat', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie: cookieA } = await registerAndLogin(app);
    const { cookie: cookieB } = await registerAndLogin(app);

    const holdA = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookieA)
      .send({ showId, seatIds: [seatId] });
    expect(holdA.status).toBe(201);
    const holdAId = holdA.body.data.hold.id;

    // Same manual rewind as the read-side test above -- still zero schedulers running to have
    // done this on their own. This is the ONLY thing standing between "A's hold is over" and
    // "the acquire predicate's own WHERE clause has to notice that itself."
    await pool.query(
      `UPDATE show_seats SET expires_at = now() - interval '1 minute'
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );

    const holdB = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookieB)
      .send({ showId, seatIds: [seatId] });

    // The literal claim under test: NOT a 409. A stale HELD row with a lapsed expires_at is not
    // "unavailable" -- acquireSeats()'s own WHERE clause is what has to reclaim it, uncontested,
    // in the same statement that assigns it to B.
    expect(holdB.status).toBe(201);
    const holdBId = holdB.body.data.hold.id;
    expect(holdBId).not.toBe(holdAId);

    const { rows } = await pool.query(
      `SELECT state, hold_id, held_by_user_id, expires_at FROM show_seats
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(rows[0].state).toBe('HELD');
    // The seat now belongs to B's hold, not A's -- not just "some hold exists."
    expect(rows[0].hold_id).toBe(holdBId);
    expect(rows[0].hold_id).not.toBe(holdAId);
    // And the new expires_at is genuinely in the future -- B got a fresh TTL, not A's stale one.
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});
