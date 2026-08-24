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
 * Does NOT own: the acquire-side races (tests/e2e/concurrency.test.js) -- this file is
 * specifically about a READ (GET /shows/:id/seatmap) reporting the truth, not about who wins a
 * contested acquire.
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
