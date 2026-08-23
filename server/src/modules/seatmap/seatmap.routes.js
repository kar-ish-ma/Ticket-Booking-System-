/**
 * seatmap.routes.js
 *
 * Owns the /shows/:id/seatmap router. Public — no auth — since a customer must be able to see
 * seat availability before logging in or booking anything.
 *
 * No business logic — everything delegates to seatmap.controller.js.
 */

import { Router } from 'express';
import * as seatmapController from './seatmap.controller.js';

export const seatmapRouter = Router();

/**
 * @openapi
 * /api/v1/shows/{id}/seatmap:
 *   get:
 *     summary: >
 *       Get a show's seat map with each seat's EFFECTIVE state (public). An expired HELD or
 *       OFFER_RESERVED row reads as AVAILABLE here even if no worker has touched it yet — see
 *       docs/PROJECT_PROMPT.md §5.1.
 *     tags: [Seatmap]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Per-seat grid plus a category legend. }
 *       404: { description: No show with this id (NOT_FOUND). }
 */
seatmapRouter.get('/:id/seatmap', seatmapController.getSeatMap);
