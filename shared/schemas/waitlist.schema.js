/**
 * waitlist.schema.js
 *
 * Owns request-body validation for waitlist joining. Imported by the server
 * (middleware/validate.js) and, later, the client.
 *
 * Does NOT own: how many seats a single waitlist entry may request in total -- that cap
 * (MAX_SEATS_PER_BOOKING) is server-only env, same reasoning as shared/schemas/hold.schema.js's
 * own header. Enforced in waitlist.service.js#joinWaitlist instead.
 *
 * Grows as later Phase 5 tasks need it: offer-detail/accept/decline shapes land with P5-5, not
 * front-loaded here.
 */

import { z } from 'zod';

export const joinWaitlistSchema = z.object({
  categoryId: z.uuid(),
  quantity: z.number().int().min(1).default(1),
});

// WHY categoryId is required here even though GET /waitlist/me carries no categoryId in its own
// path: the UNIQUE (show_id, category_id, user_id) constraint means a user's waitlist membership
// for a show is only ever unambiguous per category -- the same user could legitimately be
// WAITING in one category of a show and have no entry at all in another. Query param, not a path
// segment, since it's filtering "my membership" rather than naming a resource.
export const waitlistMeQuerySchema = z.object({
  categoryId: z.uuid(),
});
