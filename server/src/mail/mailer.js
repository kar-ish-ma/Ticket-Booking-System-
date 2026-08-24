/**
 * mailer.js
 *
 * Owns the Nodemailer transport (Ethereal auto-account in dev, real SMTP in prod), EJS template
 * rendering, and the two DB-aware "send this kind of email" entry points controllers call:
 * sendBookingConfirmedEmail() and sendWaitlistOfferEmail().
 *
 * Does NOT own the transactional-outbox pattern docs/PROJECT_PROMPT.md §7.5/CLAUDE.md describe
 * (`outbox_events` row + `OUTBOX_SEND` job, both written in the same transaction as the booking).
 * That's P4-6, and it isn't built -- see Decisions Ledger D-54. This file is called directly by
 * bookings.controller.js AFTER a booking/cancellation's transaction has already committed, fire-
 * and-forget: a failed send is logged, never surfaced as a failed booking. Nothing here runs
 * inside a database transaction, so no function here takes a `client` -- every DB read it needs
 * (the recipient's email, show/category detail for the template) goes through the shared `pool`.
 *
 * Invariant this file introduces: a booking or a cancellation can succeed with no email ever
 * sent (a down mail server, a network blip) -- CLAUDE.md's "emails go through outbox_events"
 * invariant does not hold for this file. Documented, not silently violated: see D-54.
 */

import nodemailer from 'nodemailer';
import ejs from 'ejs';
import QRCode from 'qrcode';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import * as authQueries from '../modules/auth/auth.queries.js';
import * as showsQueries from '../modules/shows/shows.queries.js';
import * as venuesQueries from '../modules/venues/venues.queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'templates');

// WHY memoised as a module-level promise, not created fresh per send: nodemailer.createTestAccount()
// is a real network call to Ethereal's API. Creating a new throwaway inbox for every single email
// sent (every booking, every cancellation-with-a-waiting-entry) would be wasteful and slow -- one
// account, reused for the life of this process, is what a real SMTP_HOST config would look like
// too (one set of credentials, not one per message).
let transportPromise = null;

/**
 * @returns {Promise<import('nodemailer').Transporter>}
 */
function getTransport() {
  if (!transportPromise) {
    transportPromise = env.SMTP_HOST
      ? Promise.resolve(
          nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          })
        )
      : nodemailer.createTestAccount().then((account) =>
          nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: account.user, pass: account.pass },
          })
        );
  }
  return transportPromise;
}

/**
 * @param {string} templateName - filename without extension, under mail/templates/
 * @param {object} data
 * @returns {Promise<string>} rendered HTML
 */
function renderTemplate(templateName, data) {
  return ejs.renderFile(path.join(TEMPLATES_DIR, `${templateName}.ejs`), data);
}

/**
 * The low-level send: builds and dispatches one message, then logs the Ethereal preview URL if
 * this transport is a test account (nodemailer.getTestMessageUrl() returns a URL string only for
 * Ethereal-created accounts, `false` for anything else -- safe to call unconditionally).
 *
 * @param {{ to: string, subject: string, html: string, attachments?: object[] }} params
 * @returns {Promise<{ previewUrl: string | false }>} `previewUrl` is what
 *   nodemailer.getTestMessageUrl() returns -- a URL string for an Ethereal-created transport,
 *   `false` for anything else (a real SMTP_HOST). Returned, not just logged, so a test can assert
 *   on it directly instead of scraping console output.
 */
async function sendMail({ to, subject, html, attachments }) {
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: env.MAIL_FROM || 'Ticket Booking <no-reply@ticketbooking.local>',
    to,
    subject,
    html,
    attachments,
  });
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    // WHY console, not pino/req.log: this file has no request in scope (it's called
    // fire-and-forget, after the controller has already responded) and env.js itself sets the
    // precedent of using console for output that must be visible before/around the app's normal
    // logging pipeline.
    console.log(`[mail] Ethereal preview: ${previewUrl}`);
  }
  return { previewUrl };
}

/**
 * Booking-confirmed email: reference, seats, total, and the QR embedded inline via CID (§8) --
 * the customer sees the ticket in the email body itself, not as a separate download.
 *
 * @param {{ userId: string, booking: object, seats: Array<{ rowLabel: string, seatNumber: number, priceCents: number }> }} params
 * @returns {Promise<{ previewUrl: string | false } | undefined>} `undefined` only in the
 *   defensive no-such-user case below
 * @throws never -- errors are the caller's to catch and log; a failed send must never fail the
 *   booking that already committed (see this file's own header)
 */
export async function sendBookingConfirmedEmail({ userId, booking, seats }) {
  const [user, show] = await Promise.all([
    authQueries.findUserById(pool, userId),
    showsQueries.findShowDetailById(pool, booking.showId),
  ]);
  if (!user) return undefined; // defensive -- booking.userId should always resolve to a real user

  // docs/PROJECT_PROMPT.md §8's QR encodes a signed JWT once P4-5 exists; today booking.qrToken is
  // still P4-2's placeholder string (docs/BUILD_LOG.md's Phase 4 debt) -- this function renders
  // whatever token the booking actually carries into an image. Rendering is P4-7's job; what the
  // token IS is P4-5's, unbuilt either way.
  const qrBuffer = await QRCode.toBuffer(booking.qrToken, { errorCorrectionLevel: 'H', width: 512 });

  const html = await renderTemplate('bookingConfirmed', { booking, seats, show });

  return sendMail({
    to: user.email,
    subject: `Booking confirmed — ${show.event.title}`,
    html,
    attachments: [{ filename: 'ticket-qr.png', content: qrBuffer, cid: 'qr-ticket' }],
  });
}

/**
 * Waitlist-offer email: which show/category, how many seats, the deadline, and the claim link
 * (§7.3 -- the raw token exists only here and in memory; it is never written to the database).
 *
 * @param {{ userId: string, showId: string, categoryId: string, offer: object, rawToken: string, seatCount: number }} params
 * @returns {Promise<{ previewUrl: string | false } | undefined>}
 * @throws never -- same reasoning as sendBookingConfirmedEmail()
 */
export async function sendWaitlistOfferEmail({ userId, showId, categoryId, offer, rawToken, seatCount }) {
  const [user, show, category, prices] = await Promise.all([
    authQueries.findUserById(pool, userId),
    showsQueries.findShowDetailById(pool, showId),
    venuesQueries.findCategoryById(pool, categoryId),
    showsQueries.listShowPrices(pool, showId),
  ]);
  if (!user) return undefined;

  const priceRow = prices.find((p) => p.categoryId === categoryId);
  const totalCents = (priceRow?.priceCents ?? 0) * seatCount;
  // WHY a claim link is built even though nothing in this codebase can resolve it: P5-5
  // (GET/POST .../accept) is dropped, per the 2026-08-24 scope decision recorded in
  // docs/BUILD_LOG.md. The offer, its token, and this email are all genuine; the link is a real,
  // working URL shape (docs/PROJECT_PROMPT.md §7.3) that currently 404s. Documented, not hidden.
  const claimUrl = `${env.WEB_URL}/waitlist/claim/${rawToken}`;

  const html = await renderTemplate('waitlistOffer', {
    show,
    category,
    seatCount,
    totalCents,
    claimUrl,
    expiresAt: offer.expiresAt,
  });

  return sendMail({
    to: user.email,
    subject: `Seats available — ${show.event.title}`,
    html,
  });
}
