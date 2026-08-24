/**
 * offers.controller.js
 *
 * Owns translating HTTP <-> offers.service.js for the public, token-authenticated claim routes
 * (P5-5). No business logic and no SQL live here.
 *
 * Does NOT own: offer creation (bookings.service.js#cancelBooking -> offers.service.js#createInitialOffer).
 */

import * as offersService from './offers.service.js';

/**
 * GET /api/v1/waitlist/offers/:token — public, no requireAuth: the token itself is the
 * authorization.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getOffer(req, res, next) {
  try {
    const result = await offersService.getOfferByToken(req.params.token);
    res.status(200).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/waitlist/offers/:token/accept — public, no requireAuth: same reasoning as
 * getOffer() above.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function acceptOffer(req, res, next) {
  try {
    const result = await offersService.acceptOffer(req.params.token);
    res.status(200).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}
