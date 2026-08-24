/**
 * fixtures.js
 *
 * Owns building a bookable show over real HTTP against a Supertest-mounted app -- venue,
 * category, seats, event, show, publish -- so every e2e test file doesn't repeat that six-step
 * setup by hand. Not itself a test file.
 *
 * Does NOT own: truncation, migration, or pointing at the test database (testDb.js, testEnv.js).
 */

import request from 'supertest';
import argon2 from 'argon2';

import { pool } from '../../src/db/pool.js';

function extractCookieHeader(res) {
  const setCookie = res.headers['set-cookie'] ?? [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

let uniqueCounter = 0;
function uniqueEmail(prefix) {
  uniqueCounter += 1;
  return `${prefix}-${Date.now()}-${uniqueCounter}@test.local`;
}

/**
 * Registers a fresh CUSTOMER or ORGANISER through the real POST /auth/register endpoint and
 * returns a ready-to-send `Cookie` header -- the same string a browser would send back after
 * receiving that response's Set-Cookie headers.
 *
 * @param {import('express').Express} app
 * @param {{ role?: 'CUSTOMER' | 'ORGANISER', email?: string }} [options]
 * @returns {Promise<{ cookie: string, userId: string }>}
 */
export async function registerAndLogin(app, { role = 'CUSTOMER', email } = {}) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({
      email: email ?? uniqueEmail(role.toLowerCase()),
      password: 'Password123!',
      name: `Test ${role}`,
      role,
    });
  if (res.status !== 201) {
    throw new Error(`registerAndLogin failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { cookie: extractCookieHeader(res), userId: res.body.data.user.id };
}

/**
 * ADMIN can't self-register through the public endpoint by design (auth.service.js,
 * Decisions Ledger D-28) -- this inserts the row directly, the one place this test harness
 * deliberately bypasses the app's own authorization rule, then logs in through the REAL
 * POST /auth/login so the cookie it returns is indistinguishable from any other session's.
 *
 * @param {import('express').Express} app
 * @returns {Promise<{ cookie: string }>}
 */
export async function createAdminAndLogin(app) {
  const email = uniqueEmail('admin');
  const password = 'Password123!';
  const passwordHash = await argon2.hash(password);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Test Admin', 'ADMIN')`,
    [email, passwordHash]
  );

  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`createAdminAndLogin failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { cookie: extractCookieHeader(res) };
}

/**
 * Builds one published, bookable show with a single row of seats (A1..A{seatCount}) by driving
 * the exact same HTTP sequence an admin and an organiser would perform by hand: create venue ->
 * category -> seats -> event -> show -> publish. Returns seat ids keyed by label so a test can
 * ask for "A1"/"A2" instead of juggling raw uuids it would otherwise have to fetch separately.
 *
 * @param {import('express').Express} app
 * @param {{ seatCount?: number, offerTtlSeconds?: number }} [options]
 * @returns {Promise<{ showId: string, categoryId: string, venueId: string, seatIdByLabel: Record<string, string> }>}
 */
export async function buildBookableShow(app, { seatCount = 6, offerTtlSeconds } = {}) {
  const { cookie: adminCookie } = await createAdminAndLogin(app);
  const { cookie: organiserCookie } = await registerAndLogin(app, { role: 'ORGANISER' });

  const venueRes = await request(app)
    .post('/api/v1/venues')
    .set('Cookie', adminCookie)
    .send({ name: 'Test Venue', address: '1 Test St', city: 'Testville' });
  const venueId = venueRes.body.data.venue.id;

  const categoryRes = await request(app)
    .post(`/api/v1/venues/${venueId}/categories`)
    .set('Cookie', adminCookie)
    .send({ name: 'Standard' });
  const categoryId = categoryRes.body.data.category.id;

  await request(app)
    .post(`/api/v1/venues/${venueId}/seats/bulk`)
    .set('Cookie', adminCookie)
    .send({ rows: [{ rowLabel: 'A', count: seatCount, categoryId, gridRow: 1 }] });

  const eventRes = await request(app)
    .post('/api/v1/events')
    .set('Cookie', organiserCookie)
    .send({ title: 'Test Event', type: 'MOVIE', durationMin: 100 });
  const eventId = eventRes.body.data.event.id;

  const showRes = await request(app)
    .post(`/api/v1/events/${eventId}/shows`)
    .set('Cookie', organiserCookie)
    .send({
      venueId,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      prices: [{ categoryId, priceCents: 1000 }],
      // Undefined when the caller doesn't pass it -- omitted from the JSON body entirely, so the
      // show falls back to its own column default (900s), same as every other caller of this
      // fixture already relies on. Only set explicitly by tests asserting D-14's reserved_until
      // formula against a known, small offer_ttl_seconds.
      ...(offerTtlSeconds !== undefined ? { offerTtlSeconds } : {}),
    });
  const showId = showRes.body.data.show.id;

  await request(app).post(`/api/v1/shows/${showId}/publish`).set('Cookie', organiserCookie);

  const seatRows = await pool.query(
    `SELECT row_label, seat_number, id FROM seats WHERE venue_id = $1 ORDER BY seat_number`,
    [venueId]
  );
  const seatIdByLabel = {};
  for (const row of seatRows.rows) {
    seatIdByLabel[`${row.row_label}${row.seat_number}`] = row.id;
  }

  return { showId, categoryId, venueId, seatIdByLabel };
}
