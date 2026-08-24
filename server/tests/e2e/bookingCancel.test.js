/**
 * bookingCancel.test.js
 *
 * Owns the automated proof of P4-8's cancellation half: cancelBooking() refunds and releases
 * seats, idempotently, composing with P4-1's already-falsified refund() guard without any new
 * code on either side.
 *
 * Does NOT own: the waitlist/offer routing (§7.2's OFFER_RESERVED branch) -- that's Phase 5's
 * P5-3, deferred. Every seat released here goes to AVAILABLE, unconditionally, since no waitlist
 * entries can exist yet (Phase 5 hasn't built the module that lets a customer join one).
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

async function bookOneSeat(cookie, showId, seatId) {
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
  return confirmRes.body.data.booking;
}

describe('POST /api/v1/bookings/:id/cancel -- happy path', () => {
  it('refunds the payment, releases the seat, groups the response by category', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);
    const booking = await bookOneSeat(cookie, showId, seatId);

    const res = await request(app).post(`/api/v1/bookings/${booking.id}/cancel`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.cancelled).toBe(true);
    expect(res.body.data.releasedSeats).toHaveLength(1);
    expect(res.body.data.releasedSeats[0].categoryId).toBe(categoryId);
    expect(res.body.data.releasedSeats[0].seats).toHaveLength(1);
    expect(res.body.data.releasedSeats[0].seats[0].seatId).toBe(seatId);

    const bookingRow = await pool.query(`SELECT status, cancelled_at FROM bookings WHERE id = $1`, [
      booking.id,
    ]);
    expect(bookingRow.rows[0].status).toBe('CANCELLED');
    expect(bookingRow.rows[0].cancelled_at).not.toBeNull();

    const paymentRow = await pool.query(`SELECT status FROM payments WHERE booking_id = $1`, [
      booking.id,
    ]);
    expect(paymentRow.rows[0].status).toBe('REFUNDED');

    const seatRow = await pool.query(
      `SELECT state, booking_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(seatRow.rows[0].state).toBe('AVAILABLE');
    expect(seatRow.rows[0].booking_id).toBeNull();
  });
});

describe('POST /api/v1/bookings/:id/cancel -- idempotent double-cancel', () => {
  it('the second call reports cancelled:false and does not re-refund', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie } = await registerAndLogin(app);
    const booking = await bookOneSeat(cookie, showId, seatId);

    const first = await request(app).post(`/api/v1/bookings/${booking.id}/cancel`).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.cancelled).toBe(true);

    const second = await request(app).post(`/api/v1/bookings/${booking.id}/cancel`).set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(second.body.data.cancelled).toBe(false);
    expect(second.body.data.releasedSeats).toHaveLength(0);

    // Exactly one REFUNDED payment row -- composition with P4-1's own already-falsified refund()
    // guard, not a re-refund and not a second payments row.
    const refundedCount = await pool.query(
      `SELECT count(*)::int AS n FROM payments WHERE booking_id = $1 AND status = 'REFUNDED'`,
      [booking.id]
    );
    expect(refundedCount.rows[0].n).toBe(1);
  });
});

describe('POST /api/v1/bookings/:id/cancel -- ownership', () => {
  it('a non-owner cannot cancel someone else\'s booking', async () => {
    const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie: cookieA } = await registerAndLogin(app);
    const { cookie: cookieB } = await registerAndLogin(app);
    const booking = await bookOneSeat(cookieA, showId, seatId);

    const res = await request(app)
      .post(`/api/v1/bookings/${booking.id}/cancel`)
      .set('Cookie', cookieB);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const bookingRow = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
    expect(bookingRow.rows[0].status).toBe('CONFIRMED');
  });
});
