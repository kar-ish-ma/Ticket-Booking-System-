/**
 * payments.test.js
 *
 * Owns the automated proof of P4-1's mock payment gateway: authorize+capture writes a payment at
 * `CAPTURED`, and refund is idempotent-by-predicate (a second call is a no-op, never an error).
 *
 * No `bookings` module exists yet (P4-2 builds it) -- this file constructs its own minimal, valid
 * `bookings` row directly via `pool.query`, satisfying every NOT NULL column with placeholder
 * values, so payments.queries.js's real FOREIGN KEY (booking_id -> bookings.id) is exercised
 * honestly rather than mocked away.
 */

import crypto from 'node:crypto';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { pool } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/withTransaction.js';
import { migrateTestDb, truncateAllTables, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, buildBookableShow } from '../setup/fixtures.js';
import * as paymentsService from '../../src/modules/payments/payments.service.js';
import * as paymentsQueries from '../../src/modules/payments/payments.queries.js';

// Minimal app import not needed here -- fixtures.js takes an Express app because registration and
// venue/show creation go over real HTTP, but this file never calls the API itself, only the
// payments module directly against the real DB. buildBookableShow()/registerAndLogin() still need
// an app instance to drive those HTTP calls, so it's imported the same way every other e2e file
// does.
import app from '../../src/app.js';

beforeAll(async () => {
  await migrateTestDb();
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Inserts a bare-bones `bookings` row satisfying every NOT NULL column, since no bookings module
 * exists yet to do this through a real service call (that's P4-2's job). `reference`/`qr_token`
 * are placeholder strings here -- this file is testing payments, not reference/QR generation.
 */
async function insertTestBooking({ showId, userId, totalCents }) {
  const result = await pool.query(
    `INSERT INTO bookings (reference, show_id, user_id, subtotal_cents, total_cents, qr_token)
     VALUES ($1, $2, $3, $4, $4, $5)
     RETURNING id`,
    [`TEST-${crypto.randomUUID()}`, showId, userId, totalCents, `test-qr-${crypto.randomUUID()}`]
  );
  return result.rows[0].id;
}

describe('payments.service#authorizeAndCapture', () => {
  it('writes a payment that ends at CAPTURED, not left at AUTHORIZED', async () => {
    const { showId } = await buildBookableShow(app, { seatCount: 1 });
    const { userId } = await registerAndLogin(app);
    const bookingId = await insertTestBooking({ showId, userId, totalCents: 2500 });

    const captured = await withTransaction((client) =>
      paymentsService.authorizeAndCapture(client, { bookingId, amountCents: 2500 })
    );

    expect(captured.status).toBe('CAPTURED');
    expect(captured.provider).toBe('MOCK');
    expect(captured.amountCents).toBe(2500);
    expect(captured.txnRef).toMatch(/^MOCK-/);

    // Exactly one row for this booking, and it's the CAPTURED one -- not two rows (one stuck
    // AUTHORIZED, one CAPTURED), which is what a bug that inserted twice instead of updating
    // would look like.
    const rows = await pool.query(`SELECT status FROM payments WHERE booking_id = $1`, [bookingId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('CAPTURED');
  });
});

describe('payments.service#refund', () => {
  it('refunds a captured payment, then a second refund is a no-op', async () => {
    const { showId } = await buildBookableShow(app, { seatCount: 1 });
    const { userId } = await registerAndLogin(app);
    const bookingId = await insertTestBooking({ showId, userId, totalCents: 1200 });

    await withTransaction((client) =>
      paymentsService.authorizeAndCapture(client, { bookingId, amountCents: 1200 })
    );

    const refunded = await withTransaction((client) => paymentsService.refund(client, bookingId));
    expect(refunded.status).toBe('REFUNDED');

    // Second refund on the same booking: no error, returns null, row stays REFUNDED -- the
    // predicate finding nothing left to match IS the idempotency (same idiom as
    // holds.service.js#releaseHold).
    const secondRefund = await withTransaction((client) =>
      paymentsService.refund(client, bookingId)
    );
    expect(secondRefund).toBeNull();

    const row = await paymentsQueries.findPaymentByBookingId(pool, bookingId);
    expect(row.status).toBe('REFUNDED');
  });
});
