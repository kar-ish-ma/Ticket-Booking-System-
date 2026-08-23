/**
 * holds.routes.js
 *
 * Owns the /holds router. Today (P3-3): POST only. GET /:id and DELETE /:id (explicit release /
 * sendBeacon on tab close) are added by whichever later task actually needs them — most likely
 * P3-4's releaseHold() — rather than stubbed out now.
 *
 * No business logic — everything delegates to holds.controller.js.
 */

import { Router } from 'express';
import { createHoldSchema } from 'shared/schemas/hold.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import * as holdsController from './holds.controller.js';

export const holdsRouter = Router();

/**
 * @openapi
 * /api/v1/holds:
 *   post:
 *     summary: Atomically hold one or more seats for the current user (any authenticated role)
 *     tags: [Holds]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [showId, seatIds]
 *             properties:
 *               showId: { type: string }
 *               seatIds:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       201:
 *         description: Every requested seat held. Never partial — see 409.
 *       404:
 *         description: No show with this id (NOT_FOUND).
 *       409:
 *         description: >
 *           One or more requested seats are unavailable (SEATS_UNAVAILABLE). No seat is held;
 *           error.details.conflictingSeats lists which ones so the UI can flash them red.
 *       422:
 *         description: More seats requested than MAX_SEATS_PER_BOOKING allows (VALIDATION_ERROR).
 */
holdsRouter.post('/', requireAuth, validate(createHoldSchema), holdsController.createHold);
