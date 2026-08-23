/**
 * backoff.js
 *
 * Owns one exponential-backoff-with-jitter calculation, shared by the job queue poller
 * (queue/poller.js) and, later, the outbox send handler (queue/handlers/outboxSend.js, P4-6) --
 * both need an answer to "how long until we try this failed thing again," and there's no reason
 * for two different answers to that question in one codebase.
 *
 * Does NOT own: retry counting or the DEAD/FAILED status transition. Callers own that, since
 * what happens after the max attempt differs per caller (job_queue rows get marked DEAD; the
 * outbox has its own status column and semantics).
 */

/**
 * @param {number} attempts - how many attempts have been made so far (1-indexed: the attempt
 *   that just failed)
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number} milliseconds to wait before the next attempt
 */
export function nextBackoffMs(attempts, { baseMs = 1000, maxMs = 60_000 } = {}) {
  const cappedExponential = Math.min(maxMs, baseMs * 2 ** (attempts - 1));
  // WHY full jitter (a random point between 0 and the capped exponential delay), not a fixed
  // exponential curve: if every failed job backs off on the exact same schedule, a batch of
  // jobs that failed together (a brief DB blip, say) all retry in lockstep -- a thundering herd
  // hitting the database at the same instant, repeatedly. A random point inside the window
  // spreads retries out instead of synchronising them.
  return Math.floor(Math.random() * cappedExponential);
}
