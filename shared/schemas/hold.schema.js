/**
 * hold.schema.js
 *
 * Owns request-body validation for creating a seat hold. Imported by the server
 * (middleware/validate.js) and, later, the client (P7-5, so the seat map can validate a
 * selection before ever hitting the network).
 *
 * Does NOT own: how many seats a hold is allowed to contain in total — that cap
 * (MAX_SEATS_PER_BOOKING) is a server-only, env-configurable value (docs/PROJECT_PROMPT.md §12);
 * baking it into a schema shared with the client would mean either hardcoding a number here that
 * could drift from the real env value, or plumbing server config into shared code. Enforced in
 * holds.service.js#createHold instead, which already reads env.
 */

import { z } from 'zod';

export const createHoldSchema = z.object({
  showId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1, 'At least one seat is required'),
});
