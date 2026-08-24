/**
 * events.routes.js
 *
 * Owns the /events router: request validation, role + ownership gating, and Swagger
 * annotations. No business logic — everything delegates to events.controller.js.
 */

import { Router } from 'express';
import { createEventSchema, updateEventSchema, browseEventsSchema } from 'shared/schemas/event.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { requireOwnership } from '../../middleware/requireOwnership.js';
import * as eventsController from './events.controller.js';
import * as eventsService from './events.service.js';

export const eventsRouter = Router();

/**
 * @openapi
 * /api/v1/events:
 *   post:
 *     summary: Create an event (ORGANISER)
 *     tags: [Events]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, type, durationMin]
 *             properties:
 *               title: { type: string }
 *               type: { type: string, enum: [MOVIE, CONCERT] }
 *               description: { type: string }
 *               posterUrl: { type: string }
 *               language: { type: string }
 *               genre: { type: string }
 *               durationMin: { type: integer }
 *     responses:
 *       201: { description: Event created; the caller is its organiser. }
 *       403: { description: Not an organiser (FORBIDDEN). }
 *   get:
 *     summary: Browse published events (public)
 *     tags: [Events]
 *     parameters:
 *       - { in: query, name: type, schema: { type: string, enum: [MOVIE, CONCERT] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date-time } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *     responses:
 *       200: { description: Paginated events. }
 */
eventsRouter.post(
  '/',
  requireAuth,
  requireRole('ORGANISER'),
  validate(createEventSchema),
  eventsController.createEvent
);
eventsRouter.get('/', validate(browseEventsSchema, 'query'), eventsController.browseEvents);

/**
 * @openapi
 * /api/v1/events/{id}:
 *   get:
 *     summary: Get a single event (public)
 *     tags: [Events]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The event. }
 *       404: { description: No event with this id (NOT_FOUND). }
 *   patch:
 *     summary: Update an event (ORGANISER, must own the event)
 *     tags: [Events]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Any subset of createEventSchema's fields, plus isPublished.
 *     responses:
 *       200: { description: Event updated. }
 *       403: { description: Not this event's organiser (FORBIDDEN). }
 *       404: { description: No event with this id (NOT_FOUND). }
 */
eventsRouter.get('/:id', eventsController.getEvent);

/**
 * @openapi
 * /api/v1/events/{id}/summary:
 *   get:
 *     summary: >
 *       Organiser revenue/occupancy summary, per category, aggregated across every show this
 *       event has (ORGANISER, must own the event). Does not include waitlist depth — see
 *       events.service.js#getEventSummary's own header.
 *     tags: [Events]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ event, categories: [{categoryId, categoryName, totalSeats, sold, revenueCents, occupancyPercent}], totals: {...} }" }
 *       403: { description: Not this event's organiser (FORBIDDEN). }
 *       404: { description: No event with this id (NOT_FOUND). }
 */
eventsRouter.get(
  '/:id/summary',
  requireAuth,
  requireRole('ORGANISER'),
  requireOwnership(eventsService.loadEventForOwnership),
  eventsController.getEventSummary
);

eventsRouter.patch(
  '/:id',
  requireAuth,
  requireRole('ORGANISER'),
  requireOwnership(eventsService.loadEventForOwnership),
  validate(updateEventSchema),
  eventsController.updateEvent
);
