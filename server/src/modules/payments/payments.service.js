/**
 * payments.service.js
 *
 * Owns the mock payment gateway's orchestration: authorize → capture (called together by
 * confirmBooking(), P4-2) and refund (called by cancelBooking(), P4-8). Isolated in its own module
 * specifically so a real PSP integration (Stripe, etc.) drops in here later without either caller
 * having to change its own control flow (docs/PROJECT_PROMPT.md §3.1).
 *
 * Does NOT own: the raw SQL (payments.queries.js), or any HTTP concern — nothing calls this module
 * over a route directly; it's called from inside bookings.service.js's own transactions.
 */

import * as paymentsQueries from './payments.queries.js';

/**
 * Authorizes and immediately captures a mock payment for a booking, as two separate writes in the
 * SAME transaction the caller (confirmBooking()) is already inside.
 *
 * WHY two writes instead of one combined insert straight to `CAPTURED`, given a mock gateway never
 * declines between them: a real PSP has a genuine gap between authorizing (a hold on funds) and
 * capturing (money actually moves) — often a fraud check or 3D Secure step in between. Modelling
 * that boundary now, even though nothing in this codebase reads the intermediate `AUTHORIZED` row
 * today, means swapping in a real gateway later is a change to THIS module's internals, not a
 * restructuring of `confirmBooking()`'s call shape.
 *
 * @param {import('pg').PoolClient} client - must already be inside a transaction
 * @param {{ bookingId: string, amountCents: number }} params
 * @returns {Promise<object>} the payment, camelCased, `status: 'CAPTURED'`
 * @throws {Error} only if capture can't find the row this same call just inserted as `AUTHORIZED`
 *   — not a normal outcome (nothing else can see this row yet to have changed its status), so this
 *   is treated as an internal invariant violation rather than a caller-facing DomainError
 */
export async function authorizeAndCapture(client, { bookingId, amountCents }) {
  const authorized = await paymentsQueries.insertAuthorizedPayment(client, {
    bookingId,
    amountCents,
  });
  const captured = await paymentsQueries.markPaymentCaptured(client, authorized.id);
  if (!captured) {
    throw new Error(
      `payments.service.js#authorizeAndCapture: failed to capture payment ${authorized.id} ` +
        `immediately after authorizing it`
    );
  }
  return captured;
}

/**
 * Refunds a booking's captured payment. Idempotent by predicate, the same idiom
 * holds.service.js#releaseHold uses: a second call finds the row already `REFUNDED` (not
 * `CAPTURED`) and simply matches nothing, rather than throwing a special-cased "already refunded"
 * error. `cancelBooking()` (P4-8) can safely call this more than once for the same booking.
 *
 * @param {import('pg').PoolClient} client - must already be inside a transaction
 * @param {string} bookingId
 * @returns {Promise<object | null>} the refunded payment, or `null` if this booking's payment was
 *   already refunded (or was never captured) — a normal, successful outcome, never an error
 * @throws never
 */
export async function refund(client, bookingId) {
  return paymentsQueries.markPaymentRefunded(client, bookingId);
}
