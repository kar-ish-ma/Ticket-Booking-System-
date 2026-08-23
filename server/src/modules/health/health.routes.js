/**
 * health.routes.js
 *
 * Owns the liveness endpoint at GET /health.
 *
 * Does NOT own (yet): DB connectivity checks, pool stats, job_queue pending/dead counts, outbox
 * backlog, or LISTEN-connection state — those land at P9-3, once the subsystems they report on
 * exist. Today this endpoint only proves the process is up and Express is routing correctly;
 * that's the whole of what P0-4 needs it to do.
 */

import { Router } from 'express';

export const healthRouter = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Liveness check
 *     description: >
 *       Confirms the process is up and Express is routing correctly. Does not yet check DB,
 *       job_queue, or outbox state — that lands at P9-3.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: The process is alive.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     status: { type: string, example: ok }
 *                 error: { type: object, nullable: true, example: null }
 */
healthRouter.get('/', (req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' }, error: null });
});
