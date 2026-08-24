/**
 * holds.test.js
 *
 * Owns the automated proof of P3-4's mechanism: `releaseHold()` (via `DELETE /api/v1/holds/:id`)
 * is idempotent, ownership-gated, and safe against a stale holdId whose seat has since been
 * reclaimed under a different hold. All of this was previously proven only with throwaway
 * session scripts (docs/TESTING.md) -- found missing as a permanent regression test at the
 * Phase 3 close-out audit and added here.
 *
 * Does NOT own: seat acquisition itself (tests/e2e/concurrency.test.js, holdExpiry.test.js).
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

describe('DELETE /api/v1/holds/:id -- idempotent release', () => {
  it('releases once, then a second and third call on the same holdId are no-ops', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);

    const holdRes = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookie)
      .send({ showId, seatIds: [seatId] });
    expect(holdRes.status).toBe(201);
    const holdId = holdRes.body.data.hold.id;

    const del1 = await request(app).delete(`/api/v1/holds/${holdId}`).set('Cookie', cookie);
    expect(del1.status).toBe(200);
    expect(del1.body.data.released).toBe(1);

    const { rows } = await pool.query(
      `SELECT state, hold_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(rows[0].state).toBe('AVAILABLE');
    expect(rows[0].hold_id).toBeNull();

    // Same holdId, twice more -- 200 {released: 0} both times, never an error, never a second
    // "already released" branch: the SQL predicates finding nothing left to match ARE the
    // idempotency (docs/PROJECT_PROMPT.md §5.2).
    const del2 = await request(app).delete(`/api/v1/holds/${holdId}`).set('Cookie', cookie);
    expect(del2.status).toBe(200);
    expect(del2.body.data.released).toBe(0);

    const del3 = await request(app).delete(`/api/v1/holds/${holdId}`).set('Cookie', cookie);
    expect(del3.status).toBe(200);
    expect(del3.body.data.released).toBe(0);
  });
});

describe('DELETE /api/v1/holds/:id -- ownership', () => {
  it('a non-owner cannot release someone else\'s hold', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie: cookieA } = await registerAndLogin(app);
    const { cookie: cookieB } = await registerAndLogin(app);

    const holdRes = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookieA)
      .send({ showId, seatIds: [seatId] });
    expect(holdRes.status).toBe(201);
    const holdId = holdRes.body.data.hold.id;

    const delByB = await request(app).delete(`/api/v1/holds/${holdId}`).set('Cookie', cookieB);
    expect(delByB.status).toBe(403);
    expect(delByB.body.error.code).toBe('FORBIDDEN');

    // The forbidden attempt must not have changed anything -- requireOwnership blocks it before
    // releaseHold() ever runs.
    const { rows } = await pool.query(
      `SELECT state, hold_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(rows[0].state).toBe('HELD');
    expect(rows[0].hold_id).toBe(holdId);
  });
});

describe('DELETE /api/v1/holds/:id -- a stale holdId whose seat was reclaimed under a new hold', () => {
  it('releasing A after B has reclaimed the seat does not touch B\'s seat or B\'s own bookkeeping row', async () => {
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

    // Force A's TTL into the past -- no scheduler exists to do this, same as holdExpiry.test.js.
    await pool.query(
      `UPDATE show_seats SET expires_at = now() - interval '1 minute'
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );

    // The REAL createHold()/acquireSeats() path reclaims the seat under a brand-new hold B.
    const holdB = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', cookieB)
      .send({ showId, seatIds: [seatId] });
    expect(holdB.status).toBe(201);
    const holdBId = holdB.body.data.hold.id;
    expect(holdBId).not.toBe(holdAId);

    // Only NOW does A's own owner call DELETE on A's (stale) holdId.
    const delA = await request(app).delete(`/api/v1/holds/${holdAId}`).set('Cookie', cookieA);
    expect(delA.status).toBe(200);
    // A's predicate (`hold_id = $1 AND state = 'HELD'`) matches nothing -- the seat's hold_id is
    // now B's, not A's.
    expect(delA.body.data.released).toBe(0);

    const seatAfter = await pool.query(
      `SELECT state, hold_id, held_by_user_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    // B's seat is byte-for-byte untouched by A's stale release.
    expect(seatAfter.rows[0].state).toBe('HELD');
    expect(seatAfter.rows[0].hold_id).toBe(holdBId);

    const holdRows = await pool.query(
      `SELECT id, status FROM seat_holds WHERE id = ANY($1::uuid[])`,
      [[holdAId, holdBId]]
    );
    const statusById = Object.fromEntries(holdRows.rows.map((r) => [r.id, r.status]));
    // A's own bookkeeping row correctly reflects that A's hold is over -- accurate, since it
    // genuinely is, just not via an explicit release.
    expect(statusById[holdAId]).toBe('RELEASED');
    // The assertion that actually matters: B's bookkeeping row must still be ACTIVE. A predicate
    // that resolved "which row to release" by anything OTHER than the hold's own primary key
    // (e.g. "the active hold for this show") would flip this to RELEASED too, corrupting a live,
    // unrelated hold silently -- no error, no 4xx, just a customer's real hold quietly cancelled
    // out from under them.
    expect(statusById[holdBId]).toBe('ACTIVE');
  });
});
