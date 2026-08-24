/**
 * waitlist.controller.js
 *
 * Owns translating HTTP <-> waitlist.service.js. No business logic and no SQL live here.
 */

import * as waitlistService from './waitlist.service.js';

/**
 * POST /api/v1/shows/:showId/waitlist
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function joinWaitlist(req, res, next) {
  try {
    const result = await waitlistService.joinWaitlist({
      showId: req.params.showId,
      categoryId: req.body.categoryId,
      quantity: req.body.quantity,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}
