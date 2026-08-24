/**
 * payments.queries.js
 *
 * Owns the raw SQL for the `payments` table — a mock gateway's authorize/capture/refund lifecycle,
 * one row per booking (`payments.booking_id` is `UNIQUE NOT NULL`, 004_bookings.sql).
 *
 * Does NOT own: deciding WHEN to authorize, capture, or refund, or what amount to charge
 * (payments.service.js, and ultimately bookings.service.js#confirmBooking/cancelBooking, P4-2/P4-8
 * — this file only knows how to write and read the rows those decisions produce).
 *
 * Invariant: every function here takes a `client` that must already be inside a transaction (see
 * withTransaction.js's header for why calling `pool.query` here instead would silently escape it).
 * `authorizeAndCapture()` in payments.service.js calls insertAuthorizedPayment() then
 * markPaymentCaptured() as two statements in the SAME transaction the caller opened — neither
 * function opens its own.
 */

import crypto from 'node:crypto';

function mapPaymentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    provider: row.provider,
    status: row.status,
    amountCents: row.amount_cents,
    txnRef: row.txn_ref,
    createdAt: row.created_at,
  };
}

/**
 * Inserts the payment row at the `AUTHORIZED` stage of the mock gateway's lifecycle. `txn_ref` is
 * generated here (not accepted as a parameter) because a real gateway is the one thing that would
 * hand this value back at exactly this step — see payments.service.js#authorizeAndCapture for why
 * this stays a separate write from capture rather than one combined insert.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ bookingId: string, amountCents: number }} params
 * @returns {Promise<object>} the inserted payment, camelCased, `status: 'AUTHORIZED'`
 */
export async function insertAuthorizedPayment(client, { bookingId, amountCents }) {
  const txnRef = `MOCK-${crypto.randomUUID()}`;
  const result = await client.query(
    `INSERT INTO payments (booking_id, provider, status, amount_cents, txn_ref)
     VALUES ($1, 'MOCK', 'AUTHORIZED', $2, $3)
     RETURNING *`,
    [bookingId, amountCents, txnRef]
  );
  return mapPaymentRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} paymentId
 * @returns {Promise<object | null>} the payment with `status: 'CAPTURED'`, or `null` if `paymentId`
 *   didn't match a row still at `AUTHORIZED` (should not happen when called immediately after
 *   insertAuthorizedPayment() in the same transaction — see payments.service.js's own comment on
 *   this being treated as an internal invariant violation, not a normal outcome)
 */
export async function markPaymentCaptured(client, paymentId) {
  const result = await client.query(
    `UPDATE payments SET status = 'CAPTURED' WHERE id = $1 AND status = 'AUTHORIZED' RETURNING *`,
    [paymentId]
  );
  return mapPaymentRow(result.rows[0]);
}

/**
 * Keyed on `booking_id`, not a `paymentId` — every caller of refund() (cancelBooking(), P4-8) only
 * ever knows which BOOKING it's cancelling, never an opaque payment id, and `booking_id` is unique
 * per payment anyway. `status = 'CAPTURED'` in the predicate is what makes a second call a no-op:
 * mirrors holds.queries.js#markSeatHoldReleased's idiom of "the predicate IS the idempotency," not
 * a special-cased "already refunded" branch.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} bookingId
 * @returns {Promise<object | null>} the payment with `status: 'REFUNDED'`, or `null` if this
 *   booking's payment was already refunded (or was never captured) — a normal, idempotent outcome
 */
export async function markPaymentRefunded(client, bookingId) {
  const result = await client.query(
    `UPDATE payments SET status = 'REFUNDED' WHERE booking_id = $1 AND status = 'CAPTURED' RETURNING *`,
    [bookingId]
  );
  return mapPaymentRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} bookingId
 * @returns {Promise<object | null>}
 */
export async function findPaymentByBookingId(client, bookingId) {
  const result = await client.query(`SELECT * FROM payments WHERE booking_id = $1`, [bookingId]);
  return mapPaymentRow(result.rows[0]);
}
