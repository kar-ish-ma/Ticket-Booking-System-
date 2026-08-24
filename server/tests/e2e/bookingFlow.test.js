/**
 * bookingFlow.test.js
 *
 * Owns the automated proof of P4-2's confirmBooking(): the happy path, and the two
 * docs/PROJECT_PROMPT.md §6.6 scenarios that were blocked until this task built the bookings
 * module (previously tracked in that table's "lives at" column as deferred to this exact file):
 *   - confirm at expires_at + 1ms -> 410 HOLD_EXPIRED, seat not booked
 *   - 20 parallel confirms of one hold -> exactly 1 booking created
 *
 * Does NOT own: the acquire-side races (tests/e2e/concurrency.test.js) or hold expiry's read/write
 * sides (tests/e2e/holdExpiry.test.js) -- this file is specifically about the SECOND atomic
 * transition, HELD -> BOOKED, not the first one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { migrateTestDb, truncateAllTables, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, buildBookableShow } from '../setup/fixtures.js';

const SEAT_PRICE_CENTS = 1000; // fixtures.js#buildBookableShow always prices at 1000

beforeAll(async () => {
  await migrateTestDb();
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});

async function createHold(cookie, showId, seatId) {
  const res = await request(app)
    .post('/api/v1/holds')
    .set('Cookie', cookie)
    .send({ showId, seatIds: [seatId] });
  expect(res.status).toBe(201);
  return res.body.data.hold.id;
}

describe('POST /api/v1/bookings/confirm -- happy path', () => {
  it('converts a hold into a CONFIRMED booking: seat BOOKED, hold CONVERTED, payment CAPTURED', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);
    const holdId = await createHold(cookie, showId, seatId);

    const res = await request(app)
      .post('/api/v1/bookings/confirm')
      .set('Cookie', cookie)
      .send({ holdId });

    expect(res.status).toBe(201);
    expect(res.body.data.booking.status).toBe('CONFIRMED');
    expect(res.body.data.booking.totalCents).toBe(SEAT_PRICE_CENTS);
    expect(res.body.data.seats).toHaveLength(1);
    const bookingId = res.body.data.booking.id;

    const seatRow = await pool.query(
      `SELECT state, booking_id, hold_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(seatRow.rows[0].state).toBe('BOOKED');
    expect(seatRow.rows[0].booking_id).toBe(bookingId);
    expect(seatRow.rows[0].hold_id).toBeNull();

    const holdRow = await pool.query(`SELECT status FROM seat_holds WHERE id = $1`, [holdId]);
    expect(holdRow.rows[0].status).toBe('CONVERTED');

    const paymentRow = await pool.query(
      `SELECT status, amount_cents FROM payments WHERE booking_id = $1`,
      [bookingId]
    );
    expect(paymentRow.rows[0].status).toBe('CAPTURED');
    expect(paymentRow.rows[0].amount_cents).toBe(SEAT_PRICE_CENTS);

    const bookingSeatRows = await pool.query(
      `SELECT price_cents FROM booking_seats WHERE booking_id = $1`,
      [bookingId]
    );
    expect(bookingSeatRows.rows).toHaveLength(1);
    expect(bookingSeatRows.rows[0].price_cents).toBe(SEAT_PRICE_CENTS);
  });
});

describe('POST /api/v1/bookings/confirm -- expires_at + 1ms (docs/PROJECT_PROMPT.md §6.6)', () => {
  it('a hold confirmed after its TTL lapsed -> 410 HOLD_EXPIRED, nothing booked', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);
    const holdId = await createHold(cookie, showId, seatId);

    await pool.query(
      `UPDATE show_seats SET expires_at = now() - interval '1 millisecond'
        WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );

    const res = await request(app)
      .post('/api/v1/bookings/confirm')
      .set('Cookie', cookie)
      .send({ holdId });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');

    // Nothing survived: no booking row, seat still raw-stored HELD (not BOOKED -- the UPDATE's
    // own WHERE clause never matched it, so it was never touched at all), no payment row.
    const bookingCount = await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE show_id = $1`, [
      showId,
    ]);
    expect(bookingCount.rows[0].n).toBe(0);

    const seatRow = await pool.query(`SELECT state FROM show_seats WHERE show_id = $1 AND seat_id = $2`, [
      showId,
      seatId,
    ]);
    expect(seatRow.rows[0].state).toBe('HELD');

    // Scoped to this show, not a bare `SELECT count(*) FROM payments` -- this file's other tests
    // (no per-test truncation; each builds its own isolated venue/show, matching
    // concurrency.test.js's pattern) legitimately have their own CAPTURED rows elsewhere.
    const paymentCount = await pool.query(
      `SELECT count(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.show_id = $1`,
      [showId]
    );
    expect(paymentCount.rows[0].n).toBe(0);
  });
});

describe('POST /api/v1/bookings/confirm -- 20 parallel confirms of one hold (docs/PROJECT_PROMPT.md §6.6)', () => {
  it('exactly one 201, the rest 410, and exactly one booking/payment/CONVERTED hold exist', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);
    const holdId = await createHold(cookie, showId, seatId);

    const RACERS = 20;
    const responses = await Promise.all(
      Array.from({ length: RACERS }, () =>
        request(app).post('/api/v1/bookings/confirm').set('Cookie', cookie).send({ holdId })
      )
    );

    const wins = responses.filter((res) => res.status === 201);
    const losses = responses.filter((res) => res.status === 410);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(RACERS - 1);
    for (const loss of losses) {
      expect(loss.body.error.code).toBe('HOLD_EXPIRED');
    }

    const bookingCount = await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE show_id = $1`, [
      showId,
    ]);
    expect(bookingCount.rows[0].n).toBe(1);

    const capturedCount = await pool.query(
      `SELECT count(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE b.show_id = $1 AND p.status = 'CAPTURED'`,
      [showId]
    );
    expect(capturedCount.rows[0].n).toBe(1);

    const holdRow = await pool.query(`SELECT status FROM seat_holds WHERE id = $1`, [holdId]);
    expect(holdRow.rows[0].status).toBe('CONVERTED');
  });
});
