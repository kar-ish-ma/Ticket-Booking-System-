/**
 * bookings.routes.js
 *
 * Owns the /bookings router: request validation, ownership gating, and Swagger annotations. Only
 * `POST /confirm` exists so far -- history/detail (P4-9) and cancellation (P4-8) are separate,
 * later tasks. No business logic here -- everything delegates to bookings.controller.js.
 */

import { Router } from 'express';
import { confirmBookingSchema } from 'shared/schemas/booking.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import * as bookingsController from './bookings.controller.js';
import { loadHoldForOwnershipFromConfirmBody } from './bookings.service.js';

export const bookingsRouter = Router();

/**
 * @openapi
 * /api/v1/bookings/confirm:
 *   post:
 *     summary: >
 *       Convert an active hold into a confirmed booking (must own the hold). All-or-nothing: if
 *       the hold's TTL has lapsed, or a concurrent request already converted it, no booking is
 *       created and no seat is touched.
 *     tags: [Bookings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [holdId]
 *             properties:
 *               holdId: { type: string }
 *     responses:
 *       201:
 *         description: Booking confirmed; every held seat is now BOOKED.
 *       403:
 *         description: Not this hold's owner (FORBIDDEN).
 *       404:
 *         description: No hold with this id (NOT_FOUND).
 *       410:
 *         description: >
 *           This hold has no seats currently HELD under it -- expired, released, or already
 *           converted by an earlier request (HOLD_EXPIRED).
 *       422:
 *         description: Validation failed (VALIDATION_ERROR).
 */
bookingsRouter.post(
  '/confirm',
  requireAuth,
  validate(confirmBookingSchema),
  requireOwnership(loadHoldForOwnershipFromConfirmBody),
  bookingsController.confirmBooking
);
