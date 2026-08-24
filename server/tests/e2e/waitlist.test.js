/**
 * waitlist.test.js
 *
 * Owns the automated proof of P5-1: joining is gated on effective availability, unique per
 * (show, category, user), and position comes from ROW_NUMBER() over the live WAITING set --
 * including under a gap left by an entry that's no longer WAITING, which is the entire reason
 * this project stores no position column (docs/PROJECT_PROMPT.md §7.1).
 *
 * Does NOT own: leaving the waitlist, offers, or the cancellation cascade -- P5-2 onward.
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

/** Books the given seat under a fresh customer so the show's only seat leaves AVAILABLE. */
async function fillTheOnlySeat(showId, seatId) {
  const { cookie } = await registerAndLogin(app);
  const holdRes = await request(app)
    .post('/api/v1/holds')
    .set('Cookie', cookie)
    .send({ showId, seatIds: [seatId] });
  expect(holdRes.status).toBe(201);

  const confirmRes = await request(app)
    .post('/api/v1/bookings/confirm')
    .set('Cookie', cookie)
    .send({ holdId: holdRes.body.data.hold.id });
  expect(confirmRes.status).toBe(201);
}

describe('POST /api/v1/shows/:showId/waitlist -- joining', () => {
  it('succeeds once the category has zero effectively-available seats', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    await fillTheOnlySeat(showId, seatIdByLabel.A1);
    const { cookie } = await registerAndLogin(app);

    const res = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie)
      .send({ categoryId });

    expect(res.status).toBe(201);
    expect(res.body.data.entry.status).toBe('WAITING');
    expect(res.body.data.position).toBe(1);
    expect(res.body.data.total).toBe(1);

    const rows = await pool.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE show_id = $1`, [
      showId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('rejects a join while the category still has available seats', async () => {
    const { showId, categoryId } = await buildBookableShow(app, { seatCount: 6 });
    const { cookie } = await registerAndLogin(app);

    const res = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie)
      .send({ categoryId });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const rows = await pool.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE show_id = $1`, [
      showId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('rejects a second join by the same user for the same (show, category)', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    await fillTheOnlySeat(showId, seatIdByLabel.A1);
    const { cookie } = await registerAndLogin(app);

    const first = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie)
      .send({ categoryId });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie)
      .send({ categoryId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_WAITLISTED');

    const rows = await pool.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE show_id = $1`, [
      showId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('renumbers position over a gap left by an entry that is no longer WAITING', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    await fillTheOnlySeat(showId, seatIdByLabel.A1);

    const { cookie: cookie1 } = await registerAndLogin(app);
    const { cookie: cookie2 } = await registerAndLogin(app);
    const { cookie: cookie3 } = await registerAndLogin(app);

    const join1 = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie1)
      .send({ categoryId });
    expect(join1.body.data.position).toBe(1);
    expect(join1.body.data.total).toBe(1);

    const join2 = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie2)
      .send({ categoryId });
    expect(join2.body.data.position).toBe(2);
    expect(join2.body.data.total).toBe(2);

    // Simulate entry 1 leaving the queue (P5-2's DELETE /waitlist doesn't exist yet -- this is
    // the same "reach directly into the DB to force the state under test" convention every other
    // e2e file in this project already uses, e.g. holdExpiry.test.js rewinding expires_at).
    await pool.query(`UPDATE waitlist_entries SET status = 'CANCELLED' WHERE id = $1`, [
      join1.body.data.entry.id,
    ]);

    const join3 = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', cookie3)
      .send({ categoryId });

    // The 3rd person to ever join, but only the 2nd still WAITING -- ROW_NUMBER() over the
    // filtered WAITING set closes the gap entry 1 left, rather than continuing from a stored
    // counter that would have put this at position 3.
    expect(join3.body.data.position).toBe(2);
    expect(join3.body.data.total).toBe(2);
  });
});
