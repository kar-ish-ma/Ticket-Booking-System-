/**
 * holds.routes.js
 *
 * Owns the /holds router. `POST /` (P3-3) and `DELETE /:id` (P3-4). `GET /:id` is added
 * whenever a task actually needs to read a hold back rather than just create/release one.
 *
 * No business logic — everything delegates to holds.controller.js.
 */

import { Router } from 'express';
import { createHoldSchema } from 'shared/schemas/hold.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import * as holdsController from './holds.controller.js';
import { loadHoldForOwnership } from './holds.service.js';

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

/**
 * @openapi
 * /api/v1/holds/{id}:
 *   delete:
 *     summary: >
 *       Explicitly release a hold (must own it) — also the target of the client's
 *       navigator.sendBeacon fast path on tab close (docs/PROJECT_PROMPT.md §5.3). Always
 *       idempotent: releasing an already-released or already-expired hold is a normal 200, never
 *       an error.
 *     tags: [Holds]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ released: number } — 0 is a normal outcome, not a failure." }
 *       403: { description: Not this hold's owner (FORBIDDEN). }
 *       404: { description: No hold with this id (NOT_FOUND). }
 */
holdsRouter.delete(
  '/:id',
  requireAuth,
  requireOwnership(loadHoldForOwnership),
  holdsController.releaseHold
);
