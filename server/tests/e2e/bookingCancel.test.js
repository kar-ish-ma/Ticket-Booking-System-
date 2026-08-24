/**
 * bookingCancel.test.js
 *
 * Owns the automated proof of P4-8's cancellation half (refund + release, idempotently) AND
 * P5-3's waitlist/offer routing (§7.2's OFFER_RESERVED branch): a category with a waiting entry
 * gets its freed seats reserved for that entry instead of released to the public pool, all inside
 * cancelBooking()'s one transaction.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';
import { migrateTestDb, truncateAllTables, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, createAdminAndLogin, buildBookableShow } from '../setup/fixtures.js';
import * as offersQueries from '../../src/modules/waitlist/offers.queries.js';

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

/**
 * Not in tests/setup/fixtures.js: buildBookableShow() only ever creates one category, which is
 * enough for every other test in this project so far. Only this file's "resolves each category
 * independently" test needs two categories on one show, so it's a local helper rather than a
 * shared-fixture change.
 */
async function buildTwoCategoryShow(app) {
  const { cookie: adminCookie } = await createAdminAndLogin(app);
  const { cookie: organiserCookie } = await registerAndLogin(app, { role: 'ORGANISER' });

  const venueRes = await request(app)
    .post('/api/v1/venues')
    .set('Cookie', adminCookie)
    .send({ name: 'Two-Category Venue', address: '2 Test St', city: 'Testville' });
  const venueId = venueRes.body.data.venue.id;

  const categoryARes = await request(app)
    .post(`/api/v1/venues/${venueId}/categories`)
    .set('Cookie', adminCookie)
    .send({ name: 'Premium' });
  const categoryIdA = categoryARes.body.data.category.id;

  const categoryBRes = await request(app)
    .post(`/api/v1/venues/${venueId}/categories`)
    .set('Cookie', adminCookie)
    .send({ name: 'Standard' });
  const categoryIdB = categoryBRes.body.data.category.id;

  await request(app)
    .post(`/api/v1/venues/${venueId}/seats/bulk`)
    .set('Cookie', adminCookie)
    .send({
      rows: [
        { rowLabel: 'A', count: 1, categoryId: categoryIdA, gridRow: 1 },
        { rowLabel: 'B', count: 1, categoryId: categoryIdB, gridRow: 2 },
      ],
    });

  const eventRes = await request(app)
    .post('/api/v1/events')
    .set('Cookie', organiserCookie)
    .send({ title: 'Two-Category Event', type: 'MOVIE', durationMin: 100 });
  const eventId = eventRes.body.data.event.id;

  const showRes = await request(app)
    .post(`/api/v1/events/${eventId}/shows`)
    .set('Cookie', organiserCookie)
    .send({
      venueId,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      prices: [
        { categoryId: categoryIdA, priceCents: 1000 },
        { categoryId: categoryIdB, priceCents: 500 },
      ],
    });
  const showId = showRes.body.data.show.id;

  await request(app).post(`/api/v1/shows/${showId}/publish`).set('Cookie', organiserCookie);

  const seatRows = await pool.query(
    `SELECT seats.id, seats.row_label FROM seats WHERE seats.venue_id = $1`,
    [venueId]
  );
  const seatIdA = seatRows.rows.find((r) => r.row_label === 'A').id;
  const seatIdB = seatRows.rows.find((r) => r.row_label === 'B').id;

  return { showId, categoryIdA, categoryIdB, seatIdA, seatIdB };
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

describe('POST /api/v1/bookings/:id/cancel -- routes freed seats to a waiting entry (P5-3)', () => {
  it('transitions the seat to OFFER_RESERVED, creates the offer, and marks the entry OFFERED', async () => {
    // A small, known offerTtlSeconds so the D-14 formula below is asserted against exact numbers,
    // not the show's column default (900s) plus whatever env.WAITLIST_MAX_CASCADE_ATTEMPTS
    // happens to be configured to in this environment.
    const offerTtlSeconds = 100;
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, {
      seatCount: 1,
      offerTtlSeconds,
    });
    const seatId = seatIdByLabel.A1;
    const { cookie: bookerCookie } = await registerAndLogin(app);
    const booking = await bookOneSeat(bookerCookie, showId, seatId);

    // The category now has zero effective availability (its only seat is BOOKED), so a second
    // customer can join its waitlist.
    const { cookie: waiterCookie } = await registerAndLogin(app);
    const joinRes = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', waiterCookie)
      .send({ categoryId });
    expect(joinRes.status).toBe(201);
    const entryId = joinRes.body.data.entry.id;

    const beforeCancel = Date.now();
    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/cancel`)
      .set('Cookie', bookerCookie);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.releasedSeats).toHaveLength(1);
    expect(cancelRes.body.data.releasedSeats[0].categoryId).toBe(categoryId);
    expect(cancelRes.body.data.releasedSeats[0].seats[0].state).toBe('OFFER_RESERVED');

    const seatRow = await pool.query(
      `SELECT state, booking_id, expires_at, reserved_until
         FROM show_seats WHERE show_id = $1 AND seat_id = $2`,
      [showId, seatId]
    );
    expect(seatRow.rows[0].state).toBe('OFFER_RESERVED');
    expect(seatRow.rows[0].booking_id).toBeNull();

    // The user-requested D-14 assertion: reserved_until and expires_at are DIFFERENT values with
    // different meanings, not the same timestamp under two column names. A formula that
    // accidentally collapsed them (e.g. both set to now() + offerTtlSeconds) would pass every
    // other assertion in this file while silently reopening the exact bug D-14 closed -- a public
    // hold reclaiming a seat mid-cascade the instant one attempt's expires_at lapses.
    const expiresAtMs = new Date(seatRow.rows[0].expires_at).getTime();
    const reservedUntilMs = new Date(seatRow.rows[0].reserved_until).getTime();
    expect(reservedUntilMs).toBeGreaterThan(expiresAtMs);

    const expectedExpiresAtMs = beforeCancel + offerTtlSeconds * 1000;
    const expectedReservedUntilMs =
      beforeCancel + (offerTtlSeconds * env.WAITLIST_MAX_CASCADE_ATTEMPTS + 60) * 1000;
    // A few seconds of slack for real request/transaction latency between beforeCancel (measured
    // in JS, before the request even sends) and the DB's own now() -- CLAUDE.md's "now() always
    // comes from Postgres" invariant means this can't be exact to the millisecond against a JS
    // timestamp taken outside the transaction.
    expect(Math.abs(expiresAtMs - expectedExpiresAtMs)).toBeLessThan(5000);
    expect(Math.abs(reservedUntilMs - expectedReservedUntilMs)).toBeLessThan(5000);

    const offerRow = await pool.query(
      `SELECT waitlist_entry_id, show_seat_ids, attempt_no, status
         FROM waitlist_offers WHERE waitlist_entry_id = $1`,
      [entryId]
    );
    expect(offerRow.rows).toHaveLength(1);
    expect(offerRow.rows[0].attempt_no).toBe(1);
    expect(offerRow.rows[0].status).toBe('PENDING');
    expect(offerRow.rows[0].show_seat_ids).toHaveLength(1);

    const entryRow = await pool.query(`SELECT status FROM waitlist_entries WHERE id = $1`, [entryId]);
    expect(entryRow.rows[0].status).toBe('OFFERED');
  });

  it('resolves each category of a multi-category booking independently', async () => {
    const { showId, categoryIdA, categoryIdB, seatIdA, seatIdB } = await buildTwoCategoryShow(app);

    const { cookie: bookerCookie } = await registerAndLogin(app);
    const holdRes = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', bookerCookie)
      .send({ showId, seatIds: [seatIdA, seatIdB] });
    expect(holdRes.status).toBe(201);
    const confirmRes = await request(app)
      .post('/api/v1/bookings/confirm')
      .set('Cookie', bookerCookie)
      .send({ holdId: holdRes.body.data.hold.id });
    expect(confirmRes.status).toBe(201);
    const booking = confirmRes.body.data.booking;

    // Only category A gets a waiting entry -- category B's queue stays empty.
    const { cookie: waiterCookie } = await registerAndLogin(app);
    const joinRes = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', waiterCookie)
      .send({ categoryId: categoryIdA });
    expect(joinRes.status).toBe(201);

    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/cancel`)
      .set('Cookie', bookerCookie);
    expect(cancelRes.status).toBe(200);

    const byCategory = Object.fromEntries(
      cancelRes.body.data.releasedSeats.map((group) => [group.categoryId, group.seats[0].state])
    );
    expect(byCategory[categoryIdA]).toBe('OFFER_RESERVED');
    expect(byCategory[categoryIdB]).toBe('AVAILABLE');

    const seatRows = await pool.query(
      `SELECT seat_id, state FROM show_seats WHERE show_id = $1 AND seat_id = ANY($2::uuid[])`,
      [showId, [seatIdA, seatIdB]]
    );
    const stateBySeatId = Object.fromEntries(seatRows.rows.map((r) => [r.seat_id, r.state]));
    expect(stateBySeatId[seatIdA]).toBe('OFFER_RESERVED');
    expect(stateBySeatId[seatIdB]).toBe('AVAILABLE');
  });
});

describe('POST /api/v1/bookings/:id/cancel -- the offer window is exclusive (D-7)', () => {
  it('a public POST /holds cannot acquire an OFFER_RESERVED seat before reserved_until', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, {
      seatCount: 1,
      offerTtlSeconds: 100,
    });
    const seatId = seatIdByLabel.A1;
    const { cookie: bookerCookie } = await registerAndLogin(app);
    const booking = await bookOneSeat(bookerCookie, showId, seatId);

    const { cookie: waiterCookie } = await registerAndLogin(app);
    await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', waiterCookie)
      .send({ categoryId });

    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/cancel`)
      .set('Cookie', bookerCookie);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.releasedSeats[0].seats[0].state).toBe('OFFER_RESERVED');

    // This IS Decisions Ledger D-7 as an assertion rather than a comment: a random third customer
    // must not be able to hold this seat while the offer window is live, even though its CURRENT
    // expires_at is only offerTtlSeconds away -- the acquire predicate (holds.queries.js#acquireSeats,
    // §6.1/D-14) gates OFFER_RESERVED on reserved_until, not expires_at, specifically so this stays
    // true for the whole cascade window, not just until the first attempt's deadline.
    const { cookie: strangerCookie } = await registerAndLogin(app);
    const holdAttempt = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', strangerCookie)
      .send({ showId, seatIds: [seatId] });

    expect(holdAttempt.status).toBe(409);
    expect(holdAttempt.body.error.code).toBe('SEATS_UNAVAILABLE');

    const seatRow = await pool.query(`SELECT state FROM show_seats WHERE show_id = $1 AND seat_id = $2`, [
      showId,
      seatId,
    ]);
    expect(seatRow.rows[0].state).toBe('OFFER_RESERVED');
  });
});

describe('POST /api/v1/bookings/:id/cancel -- atomicity of the offer dispatch', () => {
  it('rolls back the entire cancellation if the offer insert fails mid-transaction', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
    const seatId = seatIdByLabel.A1;
    const { cookie: bookerCookie } = await registerAndLogin(app);
    const booking = await bookOneSeat(bookerCookie, showId, seatId);

    const { cookie: waiterCookie } = await registerAndLogin(app);
    const joinRes = await request(app)
      .post(`/api/v1/shows/${showId}/waitlist`)
      .set('Cookie', waiterCookie)
      .send({ categoryId });
    const entryId = joinRes.body.data.entry.id;

    // Forces a failure INSIDE cancelBooking()'s transaction, after the booking has already been
    // marked CANCELLED and the seat already transitioned to OFFER_RESERVED in this same
    // transaction -- the exact moment a missing transaction boundary would leave the worst
    // possible state behind. This mocks one named query function, not the pool/client -- it tests
    // "does a thrown error roll back everything," a different concern from the concurrency
    // suite's "never mock the pool" rule (which exists to keep real row locks in play; nothing
    // here depends on locking).
    const spy = vi
      .spyOn(offersQueries, 'insertWaitlistOffer')
      .mockRejectedValueOnce(new Error('simulated offer-insert failure'));

    try {
      const cancelRes = await request(app)
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set('Cookie', bookerCookie);
      expect(cancelRes.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // The state nothing in this system can recover from, checked directly: NOT a cancelled
    // booking with orphaned OFFER_RESERVED seats, NOT a half-refunded payment -- everything from
    // this attempt rolled back, and the booking is exactly as it was before cancellation was ever
    // attempted.
    const bookingRow = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
    expect(bookingRow.rows[0].status).toBe('CONFIRMED');

    const seatRow = await pool.query(`SELECT state, booking_id FROM show_seats WHERE show_id = $1 AND seat_id = $2`, [
      showId,
      seatId,
    ]);
    expect(seatRow.rows[0].state).toBe('BOOKED');
    expect(seatRow.rows[0].booking_id).toBe(booking.id);

    const paymentRow = await pool.query(`SELECT status FROM payments WHERE booking_id = $1`, [booking.id]);
    expect(paymentRow.rows[0].status).toBe('CAPTURED');

    const offerRows = await pool.query(`SELECT count(*)::int AS n FROM waitlist_offers WHERE waitlist_entry_id = $1`, [
      entryId,
    ]);
    expect(offerRows.rows[0].n).toBe(0);

    const entryRow = await pool.query(`SELECT status FROM waitlist_entries WHERE id = $1`, [entryId]);
    expect(entryRow.rows[0].status).toBe('WAITING');
  });
});
