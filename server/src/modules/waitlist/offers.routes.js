/**
 * offers.routes.js
 *
 * Owns the /waitlist/offers router (P5-5), mounted flat at /api/v1/waitlist/offers in app.js --
 * unlike showWaitlistRouter (mergeParams, scoped under a showId), these two routes are addressed
 * purely by :token, matching docs/PROJECT_PROMPT.md §9's literal
 * `GET /waitlist/offers/:token` / `POST /waitlist/offers/:token/accept` shape. Public: no
 * requireAuth on either route, since the token is the authorization (§7.3).
 *
 * No business logic here — everything delegates to offers.controller.js.
 */

import { Router } from 'express';
import * as offersController from './offers.controller.js';

export const offersRouter = Router();

/**
 * @openapi
 * /api/v1/waitlist/offers/{token}:
 *   get:
 *     summary: >
 *       Look up a waitlist offer by its raw claim token (public, token-authenticated). Returns
 *       the seats offered, price, and seconds remaining.
 *     tags: [Waitlist]
 *     parameters:
 *       - { in: path, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ seats, subtotalCents, totalCents, secondsRemaining, showId, categoryId }" }
 *       410: { description: Token doesn't match any PENDING offer (OFFER_INVALID), or it has expired (OFFER_EXPIRED). }
 */
offersRouter.get('/:token', offersController.getOffer);

/**
 * @openapi
 * /api/v1/waitlist/offers/{token}/accept:
 *   post:
 *     summary: >
 *       Accept a waitlist offer (public, token-authenticated). OFFER_RESERVED -> BOOKED for the
 *       offer's seats, in the same guarded-transaction shape as POST /bookings/confirm. Single-use:
 *       a second accept, or a token past its expires_at, gets 410.
 *     tags: [Waitlist]
 *     parameters:
 *       - { in: path, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ booking, seats } — same shape as POST /bookings/confirm." }
 *       410: { description: OFFER_INVALID (already used, or a concurrent accept won) or OFFER_EXPIRED. }
 */
offersRouter.post('/:token/accept', offersController.acceptOffer);
