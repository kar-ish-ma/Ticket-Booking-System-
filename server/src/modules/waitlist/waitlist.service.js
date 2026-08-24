/**
 * waitlist.service.js
 *
 * Owns waitlist join orchestration: the show/category checks that gate joining, and translating
 * the unique-constraint violation into AlreadyWaitlistedError.
 *
 * Does NOT own: the SQL itself (waitlist.queries.js), HTTP concerns (waitlist.controller.js), or
 * the cancellation-cascade / offer flow (§7.2-§7.4 -- offers.service.js, later in Phase 5).
 */

import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { NotFoundError, ValidationError, AlreadyWaitlistedError } from '../../utils/errors.js';
import * as waitlistQueries from './waitlist.queries.js';
import * as showsQueries from '../shows/shows.queries.js';

// Postgres's unique_violation SQLSTATE -- same constant venues.service.js uses for the same
// reason. Hits waitlist_entries's UNIQUE (show_id, category_id, user_id).
const UNIQUE_VIOLATION = '23505';

/**
 * @param {{ showId: string, categoryId: string, userId: string, quantity: number }} params
 * @returns {Promise<{ entry: object, position: number, total: number }>}
 * @throws {NotFoundError} if no show has this id
 * @throws {ValidationError} if quantity exceeds MAX_SEATS_PER_BOOKING, or the category still has
 *   effectively-available seats -- joining is premature; hold one directly instead
 * @throws {AlreadyWaitlistedError} if this user already has an entry for this (show, category),
 *   regardless of that entry's status -- docs/PROJECT_PROMPT.md §7.1's UNIQUE constraint is on the
 *   pair, not on "currently WAITING", so a user gets exactly one waitlist attempt per category per
 *   show, ever. Deliberate: matches this task's own wording ("unique per user/show/category")
 *   rather than a re-join feature nothing has asked for yet.
 */
export async function joinWaitlist({ showId, categoryId, userId, quantity }) {
  // Checked before any further DB round-trip, same reasoning as
  // holds.service.js#createHold's MAX_SEATS_PER_BOOKING check (D-41): server-only env, can't live
  // in the shared Zod schema. An offer for more seats than a hold could ever legally contain
  // could never convert anyway.
  if (quantity > env.MAX_SEATS_PER_BOOKING) {
    throw new ValidationError(`Cannot waitlist for more than ${env.MAX_SEATS_PER_BOOKING} seats`);
  }

  const show = await showsQueries.findShowById(pool, showId);
  if (!show) throw new NotFoundError('Show not found');

  // WHY this check reads effective availability (Layer 1's CASE expression), not raw stored
  // state: a category whose only occupied seats are stale HELD/OFFER_RESERVED rows past their
  // TTL is, per §5.1, ALREADY available -- lazy expiry doesn't stop applying just because this
  // read happens to be about the waitlist instead of the seat map. Blocking a join on a raw-state
  // count would let someone waitlist for a category that's actually free right now.
  const availableCount = await waitlistQueries.countEffectiveAvailableSeats(pool, showId, categoryId);
  if (availableCount > 0) {
    throw new ValidationError(
      'This category still has available seats -- hold one directly instead of waitlisting'
    );
  }

  let entry;
  try {
    entry = await waitlistQueries.insertWaitlistEntry(pool, { showId, categoryId, userId, quantity });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new AlreadyWaitlistedError();
    }
    throw err;
  }

  // WHY reading position back with a second query instead of computing it from the insert alone:
  // ROW_NUMBER() needs the full WAITING set at read time -- the same reasoning as
  // findQueuePosition()'s own header. This entry is included since it's already committed by the
  // time this SELECT runs (autocommit -- joinWaitlist doesn't use a transaction; a single INSERT
  // and a single read-only SELECT have nothing to roll back together).
  const position = await waitlistQueries.findQueuePosition(pool, { showId, categoryId, userId });

  return { entry, position: position.position, total: position.total };
}

/**
 * @param {{ showId: string, categoryId: string, userId: string }} params
 * @returns {Promise<{ status: string, position: number | null, total: number | null }>}
 *   `position`/`total` are null whenever the entry isn't currently WAITING -- OFFERED/CONVERTED/
 *   EXPIRED/CANCELLED entries have no place in the WAITING-only ROW_NUMBER() ranking
 *   (findQueuePosition()'s own subquery), and reporting a stale position for a queue you're no
 *   longer in would be actively misleading rather than merely incomplete.
 * @throws {NotFoundError} if this user has no waitlist_entries row for this (show, category)
 */
export async function getMyWaitlistStatus({ showId, categoryId, userId }) {
  const entry = await waitlistQueries.findEntryForUser(pool, { showId, categoryId, userId });
  if (!entry) throw new NotFoundError('No waitlist entry for this show and category');

  if (entry.status !== 'WAITING') {
    return { status: entry.status, position: null, total: null };
  }

  const position = await waitlistQueries.findQueuePosition(pool, { showId, categoryId, userId });
  return { status: entry.status, position: position.position, total: position.total };
}
