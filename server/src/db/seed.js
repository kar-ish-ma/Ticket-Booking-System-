/**
 * seed.js
 *
 * Owns demo data. Grown at the client/index.html task (2026-08-24) beyond P1-7's user-only
 * skeleton: one small venue, two published events with one published (materialised) show each,
 * so client/index.html has something real to browse the moment the server boots — the client has
 * no way to create an event or a show itself (organiser/admin screens are out of scope, see D-53's
 * sibling scope cuts), so without this the seat map and booking flow would have nothing to point
 * at. Still idempotent: every insert here is gated on "does the demo venue already exist," not
 * re-run per call. A full 3-venue/8-event/20-show/sold-out-waitlist seed (docs/PROJECT_PROMPT.md
 * §13) remains future work — this is deliberately just enough for one clean demo pass.
 *
 * Does NOT own: anything beyond users, one venue, and two event/show pairs.
 */

import argon2 from 'argon2';

import { pool } from './pool.js';

// WHY a fixed, documented password instead of a random one per user:
// This is demo/grader data, not a production account — the whole point is that DEMO.md (P10-7)
// can hand a grader one password that just works for all three roles, rather than making them
// dig through a database to find out what was generated.
const DEMO_PASSWORD = 'Password123!';

const DEMO_USERS = [
  { email: 'admin@ticketbooking.test', name: 'Demo Admin', role: 'ADMIN' },
  { email: 'organiser@ticketbooking.test', name: 'Demo Organiser', role: 'ORGANISER' },
  { email: 'customer@ticketbooking.test', name: 'Demo Customer', role: 'CUSTOMER' },
];

async function seed() {
  for (const demoUser of DEMO_USERS) {
    const passwordHash = await argon2.hash(DEMO_PASSWORD);

    // WHY ON CONFLICT DO NOTHING instead of checking existence first:
    // One atomic statement, no read-then-write window. Idempotency falls out of the UNIQUE
    // (email) constraint already on the table (001_init.sql) rather than being re-implemented
    // here as an application-level check that could itself race a second seed run.
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [demoUser.email, passwordHash, demoUser.name, demoUser.role]
    );

    console.log(
      result.rowCount > 0
        ? `Created: ${demoUser.email} (${demoUser.role})`
        : `Already exists, skipped: ${demoUser.email} (${demoUser.role})`
    );
  }

  await seedDemoCatalogue();

  await pool.end();
}

const DEMO_VENUE_NAME = 'Grand Cinema Hall';

/**
 * One venue (4 rows x 8 seats, 2 categories), two published events (one MOVIE, one CONCERT), each
 * with one published show — materialised show_seats included, so GET /shows/:id/seatmap works
 * immediately. Raw SQL, not the venues/events/shows service layer: seed data is inserted directly
 * (same idiom the users loop above already uses), and skipping the HTTP/service round-trip is
 * what keeps this fast enough to run on every `npm run db:seed`.
 *
 * @returns {Promise<void>}
 */
async function seedDemoCatalogue() {
  const existing = await pool.query(`SELECT id FROM venues WHERE name = $1`, [DEMO_VENUE_NAME]);
  if (existing.rowCount > 0) {
    console.log(`Already exists, skipped: demo catalogue (venue "${DEMO_VENUE_NAME}")`);
    return;
  }

  const organiser = await pool.query(
    `SELECT id FROM users WHERE email = 'organiser@ticketbooking.test'`
  );
  const organiserId = organiser.rows[0].id;

  const venue = await pool.query(
    `INSERT INTO venues (name, address, city, layout_meta)
     VALUES ($1, '1 Demo Plaza', 'Springfield', $2::jsonb)
     RETURNING id`,
    [DEMO_VENUE_NAME, JSON.stringify({ rows: 4, cols: 8, aisleAfterCols: [4], stagePosition: 'TOP' })]
  );
  const venueId = venue.rows[0].id;

  const premium = await pool.query(
    `INSERT INTO seat_categories (venue_id, name, color_hex, sort_order)
     VALUES ($1, 'Premium', '#f59e0b', 0) RETURNING id`,
    [venueId]
  );
  const standard = await pool.query(
    `INSERT INTO seat_categories (venue_id, name, color_hex, sort_order)
     VALUES ($1, 'Standard', '#6366f1', 1) RETURNING id`,
    [venueId]
  );
  const premiumId = premium.rows[0].id;
  const standardId = standard.rows[0].id;

  // WHY rows A/B Premium, C/D Standard rather than unnest()-in-one-call like
  // venues.queries.js#insertSeatsBulk: this is a one-time seed script, not a hot request path —
  // four small INSERTs read more plainly here than building four parallel JS arrays would.
  const ROW_LABELS = ['A', 'B', 'C', 'D'];
  const seatIds = [];
  for (let r = 0; r < ROW_LABELS.length; r++) {
    const categoryId = r < 2 ? premiumId : standardId;
    for (let c = 1; c <= 8; c++) {
      const seat = await pool.query(
        `INSERT INTO seats (venue_id, category_id, row_label, seat_number, grid_row, grid_col)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [venueId, categoryId, ROW_LABELS[r], c, r + 1, c]
      );
      seatIds.push(seat.rows[0].id);
    }
  }

  const EVENTS = [
    {
      title: 'The Last Voyage',
      type: 'MOVIE',
      description: 'A crew races the clock as their ship drifts toward the edge of the map.',
      durationMin: 118,
      startsInHours: 26,
    },
    {
      title: 'Midnight Static',
      type: 'CONCERT',
      description: 'A one-night-only live set from a band that never plays the same city twice.',
      durationMin: 90,
      startsInHours: 50,
    },
  ];

  for (const demoEvent of EVENTS) {
    const event = await pool.query(
      `INSERT INTO events (organiser_id, title, type, description, duration_min, is_published)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [organiserId, demoEvent.title, demoEvent.type, demoEvent.description, demoEvent.durationMin]
    );
    const eventId = event.rows[0].id;

    const startsAt = new Date(Date.now() + demoEvent.startsInHours * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + demoEvent.durationMin * 60_000);
    const show = await pool.query(
      `INSERT INTO shows (event_id, venue_id, starts_at, ends_at, hold_ttl_seconds, offer_ttl_seconds)
       VALUES ($1, $2, $3, $4, 120, 180) RETURNING id`,
      [eventId, venueId, startsAt, endsAt]
    );
    const showId = show.rows[0].id;

    await pool.query(
      `INSERT INTO show_prices (show_id, category_id, price_cents) VALUES ($1, $2, 1500), ($1, $3, 1000)`,
      [showId, premiumId, standardId]
    );

    // The literal §4's "one show_seats row per seat" materialisation — shows.queries.js#materialiseShowSeats
    // does the same INSERT ... SELECT for a real publish; done as a plain unnest() here since
    // seedDemoCatalogue already has seatIds/categoryIds in hand from the loop above.
    await pool.query(
      `INSERT INTO show_seats (show_id, seat_id, category_id, state)
       SELECT $1, id, category_id, 'AVAILABLE'
         FROM seats WHERE id = ANY($2::uuid[])`,
      [showId, seatIds]
    );

    console.log(`Created: demo show "${demoEvent.title}" (${showId})`);
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
