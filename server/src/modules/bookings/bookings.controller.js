/**
 * bookings.controller.js
 *
 * Owns translating HTTP <-> bookings.service.js. No business logic and no SQL live here.
 */

import * as bookingsService from './bookings.service.js';

/**
 * POST /api/v1/bookings/confirm
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function confirmBooking(req, res, next) {
  try {
    const result = await bookingsService.confirmBooking({
      holdId: req.body.holdId,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}
