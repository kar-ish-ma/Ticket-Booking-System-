/**
 * shows.routes.js
 *
 * Owns two routers, because shows sit at the join of two URL shapes (docs/PROJECT_PROMPT.md §9):
 * `eventShowsRouter` — mounted at /api/v1/events/:eventId/shows in app.js, `{ mergeParams: true }`
 * so it can read :eventId — handles creation, which is naturally scoped to its parent event.
 * `showsRouter` — mounted at /api/v1/shows — handles the flat /shows/:id detail and publish
 * routes, which have nothing to do with the URL shape once a show exists.
 *
 * No business logic here — everything delegates to shows.controller.js.
 */

import { Router } from 'express';
import { createShowSchema } from 'shared/schemas/event.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import * as showsController from './shows.controller.js';
import * as showsService from './shows.service.js';
import { loadEventForOwnership } from '../events/events.service.js';

export const eventShowsRouter = Router({ mergeParams: true });
export const showsRouter = Router();

/**
 * @openapi
 * /api/v1/events/{eventId}/shows:
 *   post:
 *     summary: Create a show for an event, with per-category pricing (ORGANISER, must own the event)
 *     tags: [Shows]
 *     parameters:
 *       - { in: path, name: eventId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [venueId, startsAt, endsAt, prices]
 *             properties:
 *               venueId: { type: string }
 *               startsAt: { type: string, format: date-time }
 *               endsAt: { type: string, format: date-time }
 *               holdTtlSeconds: { type: integer }
 *               offerTtlSeconds: { type: integer }
 *               prices:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [categoryId, priceCents]
 *                   properties:
 *                     categoryId: { type: string }
 *                     priceCents: { type: integer }
 *     responses:
 *       201: { description: "Show created with its prices. Not yet bookable — see POST /shows/:id/publish." }
 *       403: { description: Not this event's organiser (FORBIDDEN). }
 *       404: { description: "venueId or a prices[].categoryId does not exist (NOT_FOUND)." }
 */
eventShowsRouter.post(
  '/',
  requireAuth,
  requireRole('ORGANISER'),
  requireOwnership(loadEventForOwnership),
  validate(createShowSchema),
  showsController.createShow
);

/**
 * @openapi
 * /api/v1/shows/{id}:
 *   get:
 *     summary: Get show detail — event, venue, and prices (public)
 *     tags: [Shows]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The show. }
 *       404: { description: No show with this id (NOT_FOUND). }
 */
showsRouter.get('/:id', showsController.getShow);

/**
 * @openapi
 * /api/v1/shows/{id}/publish:
 *   post:
 *     summary: >
 *       Materialise show_seats from the venue's layout — the moment a show becomes bookable
 *       (ORGANISER, must own the show's event). One-time; see docs/PROJECT_PROMPT.md §4.2.
 *     tags: [Shows]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Seats materialised. }
 *       403: { description: Not this show's event's organiser (FORBIDDEN). }
 *       404: { description: No show with this id (NOT_FOUND). }
 *       409: { description: This show has already been published (CONFLICT). }
 */
showsRouter.post(
  '/:id/publish',
  requireAuth,
  requireRole('ORGANISER'),
  requireOwnership(showsService.loadShowForOwnership),
  showsController.publishShow
);
