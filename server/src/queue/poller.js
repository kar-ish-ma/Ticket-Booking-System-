/**
 * poller.js
 *
 * Owns claiming job_queue rows and dispatching them to registered handlers. This is the BullMQ
 * replacement (docs/PROJECT_PROMPT.md §3.3): a delayed job is a row, and claiming it is the
 * exact same primitive (`FOR UPDATE SKIP LOCKED`) the waitlist cascade uses to claim a
 * waitlist_entries row -- one idea to explain and defend, not two.
 *
 * Does NOT own: any specific job type's handler logic. Handlers are registered by whichever
 * phase introduces that job type (HOLD_EXPIRY at P3-5, OFFER_EXPIRY at P5-6, OUTBOX_SEND at
 * P4-6) and passed in as a `{ [type]: handler }` map -- this file has no compile-time knowledge
 * of what job types exist.
 *
 * ---
 * WALKTHROUGH: runPollCycle, and what the loser of a race experiences
 *
 * 1. Two poller instances (two processes, or two ticks of the same interval overlapping under
 *    load) both call claimJobs() at nearly the same moment.
 * 2. claimJobs() is a single UPDATE statement with a FOR UPDATE SKIP LOCKED subquery. The first
 *    caller to reach Postgres takes row locks on the batch of due jobs and marks them RUNNING,
 *    incrementing `attempts`, in one atomic statement -- no read-then-write window for a second
 *    caller to land in between.
 * 3. The second caller's SKIP LOCKED subquery simply excludes every row the first caller has
 *    already locked. If there's nothing else due, it claims zero rows and returns immediately --
 *    it does NOT block waiting for the first caller's rows to free up, and it never sees or
 *    processes a row the first caller is already handling. That's what "claimed once" means
 *    here: not that the loser gets an error, but that it never had the row to begin with.
 * 4. Each claimed job's handler runs OUTSIDE the claiming statement's implicit transaction (which
 *    already committed as soon as the UPDATE...RETURNING finished) -- so a slow handler (an
 *    email send, say) never holds the row lock that protected the claim itself.
 * 5. On success, the job is marked DONE. On failure, failJob() either reschedules it with
 *    backoff (nextBackoffMs) or, past JOB_MAX_ATTEMPTS, marks it DEAD -- surfaced later at
 *    /health (P9-3).
 */

import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { nextBackoffMs } from '../utils/backoff.js';

/**
 * Atomically claims up to `limit` due PENDING jobs, marking them RUNNING.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db - `pool` in normal operation; a test
 *   may pass a specific client, but never must -- this is a single atomic statement, so it needs
 *   no surrounding withTransaction() of its own (see holds.queries.js's identical reasoning,
 *   Phase 3, for why one statement is enough).
 * @param {number} [limit]
 * @returns {Promise<Array<{id: string, type: string, payload: unknown, attempts: number}>>}
 */
export async function claimJobs(db, limit = 10) {
  const result = await db.query(
    `UPDATE job_queue
        SET status = 'RUNNING', attempts = attempts + 1
      WHERE id IN (
        SELECT id
          FROM job_queue
         WHERE status = 'PENDING' AND run_at <= now()
         ORDER BY run_at
         LIMIT $1
           FOR UPDATE SKIP LOCKED
      )
    RETURNING id, type, payload, attempts`,
    [limit]
  );
  return result.rows;
}

async function completeJob(db, id) {
  await db.query(`UPDATE job_queue SET status = 'DONE' WHERE id = $1`, [id]);
}

async function failJob(db, job, err) {
  const message = err instanceof Error ? err.message : String(err);

  if (job.attempts >= env.JOB_MAX_ATTEMPTS) {
    await db.query(`UPDATE job_queue SET status = 'DEAD', last_error = $2 WHERE id = $1`, [
      job.id,
      message,
    ]);
    return;
  }

  const delaySeconds = nextBackoffMs(job.attempts) / 1000;
  await db.query(
    `UPDATE job_queue
        SET status = 'PENDING',
            run_at = now() + make_interval(secs => $2),
            last_error = $3
      WHERE id = $1`,
    [job.id, delaySeconds, message]
  );
}

/**
 * Claims one batch of due jobs and runs each through its registered handler, in parallel.
 *
 * @param {Record<string, (payload: unknown, pool: import('pg').Pool) => Promise<void>>} handlers
 *   - map of job type to handler. A job whose type has no registered handler fails (and is
 *     retried/DEAD-ed) the same as a handler that threw -- there is no silent "type not
 *     recognised, drop the job" path.
 * @param {number} [limit]
 * @returns {Promise<number>} how many jobs this cycle claimed
 */
export async function runPollCycle(handlers, limit = 10) {
  const jobs = await claimJobs(pool, limit);

  await Promise.all(
    jobs.map(async (job) => {
      try {
        const handler = handlers[job.type];
        if (!handler) {
          throw new Error(`No handler registered for job type "${job.type}"`);
        }
        await handler(job.payload, pool);
        await completeJob(pool, job.id);
      } catch (err) {
        await failJob(pool, job, err);
      }
    })
  );

  return jobs.length;
}

/**
 * Starts polling job_queue every JOB_POLL_INTERVAL_MS. Returns a function that stops it --
 * graceful shutdown (P9-4) calls this so the process doesn't exit mid-batch with jobs stuck
 * RUNNING.
 *
 * @param {Record<string, (payload: unknown, pool: import('pg').Pool) => Promise<void>>} handlers
 * @returns {() => void} stop function
 */
export function startPoller(handlers) {
  const timer = setInterval(() => {
    runPollCycle(handlers).catch((err) => {
      // WHY console instead of pino here:
      // Same reasoning as pool.js's error handler -- this fires on a timer with no request
      // context, and no shared logger instance exists yet (P9-3).
      console.error('Poll cycle failed:', err);
    });
  }, env.JOB_POLL_INTERVAL_MS);

  // WHY unref(): a bare setInterval keeps the Node process alive forever, even after everything
  // else has finished shutting down. unref() tells Node this timer alone shouldn't do that --
  // graceful shutdown (P9-4) still calls the returned stop function explicitly; this is just a
  // safety net against the process hanging if it doesn't.
  timer.unref?.();

  return () => clearInterval(timer);
}
