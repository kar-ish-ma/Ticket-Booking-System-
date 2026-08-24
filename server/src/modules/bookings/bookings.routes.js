/**
 * bookings.routes.js
 *
 * Owns the /bookings router: request validation, ownership gating, and Swagger annotations.
 * `POST /confirm` (P4-2) and `POST /:id/cancel` (P4-8) exist so far -- history/detail (P4-9) is a
 * separate, later task. No business logic here -- everything delegates to bookings.controller.js.
 */

import { Router } from 'express';
import { confirmBookingSchema } from 'shared/schemas/booking.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import * as bookingsController from './bookings.controller.js';
import {
  loadHoldForOwnershipFromConfirmBody,
  loadBookingForOwnership,
} from './bookings.service.js';

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

/**
 * @openapi
 * /api/v1/bookings/{id}/cancel:
 *   post:
 *     summary: >
 *       Cancel a confirmed booking (must own it): refunds the payment and releases its seats.
 *       Freed seats are grouped by category — today every group goes back to AVAILABLE; once
 *       Phase 5 exists, a group with a non-empty waitlist instead becomes an offer (§7.2).
 *       Always idempotent: cancelling an already-cancelled booking is a normal 200, never an error.
 *     tags: [Bookings]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ cancelled: boolean, releasedSeats: [{categoryId, seats}] } — cancelled is false for an idempotent no-op."
 *       403:
 *         description: Not this booking's owner (FORBIDDEN).
 *       404:
 *         description: No booking with this id (NOT_FOUND).
 */
bookingsRouter.post(
  '/:id/cancel',
  requireAuth,
  requireOwnership(loadBookingForOwnership),
  bookingsController.cancelBooking
);
