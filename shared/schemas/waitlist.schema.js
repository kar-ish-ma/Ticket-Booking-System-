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
 * Grows as later Phase 5 tasks need it: position/offer-detail/accept/decline shapes land with
 * P5-2/P5-5, not front-loaded here.
 */

import { z } from 'zod';

export const joinWaitlistSchema = z.object({
  categoryId: z.uuid(),
  quantity: z.number().int().min(1).default(1),
});
