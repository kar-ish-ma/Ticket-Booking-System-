/**
 * enqueue.js
 *
 * Owns enqueueJob(client, type, payload, runAt) -- the one way anything in this codebase writes
 * to job_queue.
 *
 * Does NOT own: claiming or executing jobs (poller.js) or any specific job type's handler logic
 * (queue/handlers/*.js, added incrementally as each owning phase needs a job type -- HOLD_EXPIRY
 * at P3-5, OFFER_EXPIRY at P5-6, OUTBOX_SEND at P4-6).
 *
 * Invariant: enqueueJob always takes a client, and callers always call it from inside the SAME
 * transaction that created the thing the job is about (a hold, an offer, a booking). A hold that
 * committed without its expiry job ever landing would depend entirely on the Layer-3 reconciler
 * to notice it -- still correct, but far less timely. See withTransaction.js's header for why
 * `client`, never `pool`, is what makes "the job row and the hold row commit together" a real
 * guarantee instead of a hope.
 */

/**
 * Inserts one row into job_queue.
 *
 * @param {import('pg').PoolClient} client - MUST be the same client as the caller's surrounding
 *   transaction (see withTransaction.js's header for why).
 * @param {string} type - job type, e.g. 'HOLD_EXPIRY' | 'OFFER_EXPIRY' | 'OUTBOX_SEND'
 * @param {Record<string, unknown>} payload - JSON-serialisable data the job's handler needs
 * @param {Date} runAt - the job becomes claimable once now() >= runAt (a delayed job, not an
 *   immediate one -- see docs/PROJECT_PROMPT.md §3.3)
 * @returns {Promise<string>} the new job_queue row's id
 */
export async function enqueueJob(client, type, payload, runAt) {
  const result = await client.query(
    `INSERT INTO job_queue (type, payload, run_at)
     VALUES ($1, $2::jsonb, $3)
     RETURNING id`,
    [type, JSON.stringify(payload), runAt]
  );
  return result.rows[0].id;
}
