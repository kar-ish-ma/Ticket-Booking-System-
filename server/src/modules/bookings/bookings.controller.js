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

/**
 * POST /api/v1/bookings/:id/cancel — requireOwnership has already run. Always 200, even for an
 * idempotent no-op (already cancelled) — cancelBooking() never throws for that case, and neither
 * does this (same convention as holds.controller.js#releaseHold).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function cancelBooking(req, res, next) {
  try {
    const { cancelled, releasedSeatsByCategory } = await bookingsService.cancelBooking({
      bookingId: req.params.id,
    });
    // A Map isn't JSON-serialisable directly -- turned into the array shape §7.2's own diagram
    // already frames the mechanism in ("for each category group"), rather than an object keyed
    // by categoryId (a JS object's key order/typing is a worse fit for a list of groups).
    const releasedSeats = Array.from(releasedSeatsByCategory, ([categoryId, seats]) => ({
      categoryId,
      seats,
    }));
    res.status(200).json({ success: true, data: { cancelled, releasedSeats }, error: null });
  } catch (err) {
    next(err);
  }
}
