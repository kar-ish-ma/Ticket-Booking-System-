/**
 * waitlist.routes.js
 *
 * Owns the /shows/:showId/waitlist router, mounted with { mergeParams: true } in app.js so it can
 * read :showId -- same shape as shows.routes.js's eventShowsRouter. Only `POST /` (P5-1) exists so
 * far; position (`GET /me`), leave (`DELETE /`), and the public offer-claim routes land with
 * P5-2/P5-5.
 *
 * No business logic here — everything delegates to waitlist.controller.js.
 */

import { Router } from 'express';
import { joinWaitlistSchema } from 'shared/schemas/waitlist.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import * as waitlistController from './waitlist.controller.js';

export const showWaitlistRouter = Router({ mergeParams: true });

/**
 * @openapi
 * /api/v1/shows/{showId}/waitlist:
 *   post:
 *     summary: >
 *       Join the waitlist for a category (any authenticated role) -- allowed only when that
 *       category has zero effectively-available seats. One entry per user per (show, category),
 *       ever.
 *     tags: [Waitlist]
 *     parameters:
 *       - { in: path, name: showId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryId]
 *             properties:
 *               categoryId: { type: string }
 *               quantity: { type: integer, default: 1 }
 *     responses:
 *       201: { description: "Joined. Response includes { entry, position, total }." }
 *       404: { description: No show with this id (NOT_FOUND). }
 *       409: { description: Already waitlisted for this category (ALREADY_WAITLISTED). }
 *       422: { description: Quantity too large, or the category still has available seats (VALIDATION_ERROR). }
 */
showWaitlistRouter.post(
  '/',
  requireAuth,
  validate(joinWaitlistSchema),
  waitlistController.joinWaitlist
);
