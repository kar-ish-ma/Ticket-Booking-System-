/**
 * booking.schema.js
 *
 * Owns request-body validation for booking confirmation. History/detail/cancellation shapes are
 * added when P4-9/P4-8 build the routes that need them — this file starts minimal, matching the
 * project's established pattern of growing a schema file with the phase that needs each shape
 * (see event.schema.js's own header for the same convention).
 *
 * Does NOT own: anything about how a booking's total is computed (server-only business logic,
 * bookings.service.js) or the hold shape it's confirming (hold.schema.js).
 */

import { z } from 'zod';

// WHY no `customer{}` field, despite docs/PROJECT_PROMPT.md §9 listing
// `POST /bookings/confirm { holdId, customer{} }`: nothing in the `bookings` table needs customer
// contact info beyond `user_id`, which is already the authenticated caller (req.user.id) -- this
// is a deliberate scope simplification, not an oversight (see docs/BUILD_LOG.md's P4-2 row).
export const confirmBookingSchema = z.object({
  holdId: z.uuid(),
});
