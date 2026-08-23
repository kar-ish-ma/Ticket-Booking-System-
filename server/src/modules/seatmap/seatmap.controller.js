/**
 * seatmap.controller.js
 *
 * Owns translating HTTP <-> seatmap.service.js. No business logic and no SQL live here.
 */

import * as seatmapService from './seatmap.service.js';

/**
 * GET /api/v1/shows/:id/seatmap
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getSeatMap(req, res, next) {
  try {
    const seatMap = await seatmapService.getSeatMap(req.params.id);
    res.status(200).json({ success: true, data: seatMap, error: null });
  } catch (err) {
    next(err);
  }
}
