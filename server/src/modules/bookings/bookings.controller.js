/**
 * bookings.controller.js
 *
 * Owns translating HTTP <-> bookings.service.js. No business logic and no SQL live here.
 *
 * Also the call site for P4-7's email dispatch: fired AFTER the service call resolves (i.e. after
 * the booking/cancellation transaction has already committed), deliberately NOT awaited. A slow
 * or unreachable mail server must never make a customer wait on their booking confirmation, and
 * an email failure must never turn an already-successful booking into an HTTP error -- see
 * mail/mailer.js's own header for the invariant this trades away (CLAUDE.md's "emails go through
 * outbox_events" -- not true for this codebase; see Decisions Ledger D-54).
 */

import * as bookingsService from './bookings.service.js';
import * as mailer from '../../mail/mailer.js';

/**
 * @param {string} label - identifies which send failed, for the log line
 * @param {Promise<void>} sendPromise
 * @returns {void}
 */
function fireAndForget(label, sendPromise) {
  sendPromise.catch((err) => {
    console.error(`[mail] ${label} failed:`, err);
  });
}

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

    fireAndForget(
      `booking confirmation (${result.booking.id})`,
      mailer.sendBookingConfirmedEmail({
        userId: req.user.id,
        booking: result.booking,
        seats: result.seats,
      })
    );

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
    const { cancelled, releasedSeatsByCategory, offersCreated } = await bookingsService.cancelBooking({
      bookingId: req.params.id,
    });

    for (const created of offersCreated) {
      fireAndForget(`waitlist offer (${created.offer.id})`, mailer.sendWaitlistOfferEmail(created));
    }

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

/**
 * GET /api/v1/bookings/:id/ticket — requireOwnership has already run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getTicketQr(req, res, next) {
  try {
    const png = await bookingsService.getBookingQrPng(req.params.id);
    res.status(200).type('image/png').send(png);
  } catch (err) {
    next(err);
  }
}
