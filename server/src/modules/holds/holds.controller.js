/**
 * holds.controller.js
 *
 * Owns translating HTTP <-> holds.service.js. No business logic and no SQL live here.
 */

import * as holdsService from './holds.service.js';

/**
 * POST /api/v1/holds
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function createHold(req, res, next) {
  try {
    const result = await holdsService.createHold({
      showId: req.body.showId,
      seatIds: req.body.seatIds,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}
