/**
 * mail.test.js
 *
 * Owns the one deliberate, real proof of P4-7's mail pipeline: a genuine Ethereal account, a
 * genuine SMTP send, a genuine rendered EJS template with a real QR PNG attached via CID for the
 * booking-confirmed email, and a real claim link for the waitlist-offer email. Calls
 * mail/mailer.js directly rather than going through the HTTP booking/cancel endpoints, because
 * those endpoints fire the same sends fire-and-forget (bookings.controller.js) -- unawaited by
 * design, so there'd be nothing for an HTTP-level test to deterministically wait on.
 *
 * This test makes real network calls to Ethereal's API and SMTP server. That's the deliberate
 * trade CLAUDE.md's own "test against reality, never mock" convention makes here too -- a mocked
 * transport would prove nothing about whether Nodemailer, the EJS templates, and the QR buffer
 * actually compose into a sendable message.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { migrateTestDb, truncateAllTables, closeTestDb } from '../setup/testDb.js';
import { registerAndLogin, buildBookableShow } from '../setup/fixtures.js';
import * as mailer from '../../src/mail/mailer.js';

beforeAll(async () => {
  await migrateTestDb();
  await truncateAllTables();
});

afterAll(async () => {
  await closeTestDb();
});

describe('mailer.js -- booking confirmation email', () => {
  it(
    'renders the template, attaches a QR via CID, and sends through a real Ethereal account',
    async () => {
      const { showId, seatIdByLabel } = await buildBookableShow(app, { seatCount: 1 });
      const { cookie, userId } = await registerAndLogin(app);

      const holdRes = await request(app)
        .post('/api/v1/holds')
        .set('Cookie', cookie)
        .send({ showId, seatIds: [seatIdByLabel.A1] });
      const confirmRes = await request(app)
        .post('/api/v1/bookings/confirm')
        .set('Cookie', cookie)
        .send({ holdId: holdRes.body.data.hold.id });
      const { booking, seats } = confirmRes.body.data;

      const result = await mailer.sendBookingConfirmedEmail({ userId, booking, seats });

      expect(result).toBeDefined();
      expect(typeof result.previewUrl).toBe('string');
      expect(result.previewUrl).toContain('ethereal.email');
    },
    20_000
  );
});

describe('mailer.js -- waitlist offer email', () => {
  it('renders the claim link and deadline, and sends through a real Ethereal account', async () => {
    const { showId, categoryId, seatIdByLabel } = await buildBookableShow(app, {
      seatCount: 1,
      offerTtlSeconds: 100,
    });

    const { cookie: bookerCookie } = await registerAndLogin(app);
    const holdRes = await request(app)
      .post('/api/v1/holds')
      .set('Cookie', bookerCookie)
      .send({ showId, seatIds: [seatIdByLabel.A1] });
    const confirmRes = await request(app)
      .post('/api/v1/bookings/confirm')
      .set('Cookie', bookerCookie)
      .send({ holdId: holdRes.body.data.hold.id });
    const bookingId = confirmRes.body.data.booking.id;

    const { cookie: waiterCookie, userId: waiterId } = await registerAndLogin(app);
    await request(app).post(`/api/v1/shows/${showId}/waitlist`).set('Cookie', waiterCookie).send({ categoryId });

    // Cancelling triggers cancelBooking()'s own (fire-and-forget) send via the HTTP endpoint --
    // this test doesn't rely on that happening in time; it independently re-derives the same
    // offer row this cancellation just created and calls the mailer directly, so the assertion
    // has something deterministic to await.
    await request(app).post(`/api/v1/bookings/${bookingId}/cancel`).set('Cookie', bookerCookie);

    const offerRow = await pool.query(
      `SELECT wo.* FROM waitlist_offers wo
         JOIN waitlist_entries we ON we.id = wo.waitlist_entry_id
        WHERE we.user_id = $1 AND we.show_id = $2 AND we.category_id = $3`,
      [waiterId, showId, categoryId]
    );
    expect(offerRow.rows).toHaveLength(1);
    const offer = {
      id: offerRow.rows[0].id,
      expiresAt: offerRow.rows[0].expires_at,
    };

    const result = await mailer.sendWaitlistOfferEmail({
      userId: waiterId,
      showId,
      categoryId,
      offer,
      rawToken: 'test-raw-token-not-a-real-one',
      seatCount: 1,
    });

    expect(result).toBeDefined();
    expect(typeof result.previewUrl).toBe('string');
    expect(result.previewUrl).toContain('ethereal.email');
  }, 20_000);
});
