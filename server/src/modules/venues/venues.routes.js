/**
 * venues.routes.js
 *
 * Owns the /venues router: request validation, role gating, and Swagger annotations. No
 * business logic — everything delegates to venues.controller.js.
 *
 * WHY requireRole('ADMIN', 'ORGANISER') on the read routes but requireRole('ADMIN') alone on the
 * write routes: venue/category/seat data has no "owner" the way an event does — only ADMIN may
 * create or edit it — but an organiser building a show (P2-5) needs to browse venues and read a
 * layout to pick a venueId and categoryIds. There is no ownership check anywhere in this file;
 * that's deliberate, see venues.queries.js's header.
 */

import { Router } from 'express';
import {
  createVenueSchema,
  createCategorySchema,
  bulkCreateSeatsSchema,
} from 'shared/schemas/venue.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import * as venuesController from './venues.controller.js';

export const venuesRouter = Router();

const readAccess = [requireAuth, requireRole('ADMIN', 'ORGANISER')];
const writeAccess = [requireAuth, requireRole('ADMIN')];

/**
 * @openapi
 * /api/v1/venues:
 *   post:
 *     summary: Create a venue (ADMIN)
 *     tags: [Venues]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, address, city]
 *             properties:
 *               name: { type: string }
 *               address: { type: string }
 *               city: { type: string }
 *               layoutMeta: { type: object }
 *     responses:
 *       201: { description: Venue created. }
 *       403: { description: Not an admin (FORBIDDEN). }
 *   get:
 *     summary: List all venues (ADMIN, ORGANISER)
 *     tags: [Venues]
 *     responses:
 *       200: { description: Every venue. }
 */
venuesRouter.post('/', ...writeAccess, validate(createVenueSchema), venuesController.createVenue);
venuesRouter.get('/', ...readAccess, venuesController.listVenues);

/**
 * @openapi
 * /api/v1/venues/{id}:
 *   get:
 *     summary: Get a single venue (ADMIN, ORGANISER)
 *     tags: [Venues]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The venue. }
 *       404: { description: No venue with this id (NOT_FOUND). }
 */
venuesRouter.get('/:id', ...readAccess, venuesController.getVenue);

/**
 * @openapi
 * /api/v1/venues/{id}/categories:
 *   post:
 *     summary: Create a seat category for a venue (ADMIN)
 *     tags: [Venues]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               colorHex: { type: string }
 *               sortOrder: { type: integer }
 *     responses:
 *       201: { description: Category created. }
 *       409: { description: A category with this name already exists on this venue (CONFLICT). }
 */
venuesRouter.post(
  '/:id/categories',
  ...writeAccess,
  validate(createCategorySchema),
  venuesController.createCategory
);

/**
 * @openapi
 * /api/v1/venues/{id}/seats/bulk:
 *   post:
 *     summary: Bulk-create seats from a row spec (ADMIN)
 *     tags: [Venues]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows]
 *             properties:
 *               rows:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [rowLabel, count, categoryId, gridRow]
 *                   properties:
 *                     rowLabel: { type: string }
 *                     count: { type: integer }
 *                     categoryId: { type: string }
 *                     gridRow: { type: integer }
 *     responses:
 *       201: { description: Seats created. }
 *       409: { description: A seat number or grid position collides with an existing seat (CONFLICT). }
 */
venuesRouter.post(
  '/:id/seats/bulk',
  ...writeAccess,
  validate(bulkCreateSeatsSchema),
  venuesController.bulkCreateSeats
);

/**
 * @openapi
 * /api/v1/venues/{id}/layout:
 *   get:
 *     summary: Get a venue's full layout — categories and seats (ADMIN, ORGANISER)
 *     tags: [Venues]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Venue, categories, and seats. }
 *       404: { description: No venue with this id (NOT_FOUND). }
 */
venuesRouter.get('/:id/layout', ...readAccess, venuesController.getVenueLayout);
