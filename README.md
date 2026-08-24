# Ticket Booking System

A PostgreSQL-backed ticket-booking API and single-page demo that treats seat allocation as a database concurrency problem.

**Live URL:** [https://ticket-booking-system-dzwg.onrender.com](https://ticket-booking-system-dzwg.onrender.com) (free tier — first request may take ~50s to wake)

**50 concurrent requests for the same seat. Exactly one wins, every time — verified by a test suite that fails when the mechanism is removed.**

## Try it

| Role | Email | Password |
|---|---|---|
| Customer | `customer@ticketbooking.test` | `Password123!` |
| Organiser | `organiser@ticketbooking.test` | `Password123!` |
| Admin | `admin@ticketbooking.test` | `Password123!` |

1. Open the live URL and sign in as the customer.
2. Browse a published event and open one of its shows.
3. Select up to six available seats, then create a time-limited hold.
4. Confirm the booking to create a ticket and display its QR code.
5. Cancel the booking to release seats; a matching waitlist entry receives a private offer instead of public inventory.

The concurrency, expiry, waitlist, and offer invariants are described in [the system design](docs/SYSTEM_DESIGN.md).

## Scope

| Implemented | Deferred / deliberately cut |
|---|---|
| PostgreSQL schema, migrations, seed data, venues, events, shows, and seat maps | Realtime Socket.IO seat-map updates and `pg_notify` broadcasting |
| Cookie auth, refresh rotation, roles, and ownership checks | Hold-expiry jobs and reconciliation workers; lazy SQL expiry remains correct without them |
| Atomic holds, lazy TTL reclaim, idempotent release, booking confirmation, mock payments, and QR PNGs | Booking idempotency keys, production QR signing, booking history, PDF tickets, and real payments |
| Waitlist join/position, cancellation-driven private offers, token-hash storage, and offer acceptance | Automatic expired-offer cascade/re-offer and a waitlist leave endpoint |
| Vanilla browser client, Swagger, linting, and PostgreSQL-backed Vitest/Supertest tests | Transactional email outbox/retry; email is sent directly after commit |

## Local setup

Requirements: Node.js 20+, PostgreSQL 16+, and npm.

```powershell
npm install
Copy-Item .env.example .env
```

Create `ticket_booking` and `ticket_booking_test`, then set `DATABASE_URL` in `.env`. Generate three different secrets of at least 32 characters for the two JWT variables and `QR_SIGNING_SECRET`, then run:

```powershell
npm run db:migrate
npm run db:seed
npm run dev:server
```

Open `http://localhost:3000`. Migrations run against `DATABASE_URL`; use `npm run db:migrate:down` or `npm run db:reset` only when intentionally changing local schema state.

## Environment

Copy `.env.example`; validation at boot rejects missing required values and a QR secret reused as an auth secret.

| Variable | Default | Comment |
|---|---:|---|
| `NODE_ENV` | `development` | Runtime mode. |
| `PORT` | `3000` | Express listener port. |
| `API_URL` | `http://localhost:3000` | Public API base used in externally resolvable links. |
| `WEB_URL` | `http://localhost:3000` | Browser origin, CORS allowlist, and email claim-link base. |
| `DATABASE_URL` | — | Required PostgreSQL connection string. |
| `PGPOOL_MAX` | `10` | Per-process `pg` connection-pool ceiling. |
| `JOB_POLL_INTERVAL_MS` | `2000` | Due-job polling interval for future/background work. |
| `JOB_MAX_ATTEMPTS` | `5` | Retry limit before a queued job becomes dead. |
| `JWT_ACCESS_SECRET` | — | Required 32+ character access-token signing secret. |
| `JWT_REFRESH_SECRET` | — | Required 32+ character refresh-token signing secret. |
| `JWT_ACCESS_TTL` | `15m` | Access-token lifetime. |
| `JWT_REFRESH_TTL` | `7d` | Refresh-token lifetime. |
| `QR_SIGNING_SECRET` | — | Required 32+ character ticket secret; must differ from both JWT secrets. |
| `SEAT_HOLD_TTL_SECONDS` | `600` | Default per-show hold duration. |
| `WAITLIST_OFFER_TTL_SECONDS` | `900` | Current offer deadline. |
| `WAITLIST_MAX_CASCADE_ATTEMPTS` | `5` | Defines the maximum private-reservation window. |
| `HOLD_RECONCILER_CRON` | `*/30 * * * * *` | Reserved schedule for the deferred hold sweep. |
| `OUTBOX_RECONCILER_CRON` | `*/60 * * * * *` | Reserved schedule for the deferred email-outbox sweep. |
| `MAX_SEATS_PER_BOOKING` | `6` | Server-enforced seat and waitlist quantity cap. |
| `BOOKING_FEE_PERCENT` | `0` | Fee percentage added to the subtotal. |
| `SMTP_HOST` | empty | Empty uses an Ethereal test account in development. |
| `SMTP_PORT` | empty | SMTP port when a real host is configured. |
| `SMTP_USER` | empty | SMTP username. |
| `SMTP_PASS` | empty | SMTP password. |
| `MAIL_FROM` | empty | Sender address for real SMTP delivery. |
| `RATE_LIMIT_HOLD_PER_MIN` | `10` | Per-user hold-create rate limit. |

## Architecture and layout

Express 5 serves both the JSON API and `client/index.html`; Node uses raw `pg` SQL and PostgreSQL is the only required service. Domain modules own routes, controllers, services, and queries. Services define transaction boundaries; queries carry guarded state transitions; shared schemas and errors keep HTTP contracts consistent.

```text
client/                     Single-file browser client
server/src/config/          Environment and Swagger
server/src/db/              Pool, transactions, migrations, seed
server/src/modules/         auth, venues, events, shows, seatmap, holds,
                            bookings, payments, waitlist
server/tests/               Unit and PostgreSQL-backed E2E tests
shared/                     Seat-state machine, schemas, error codes
docs/                       Build log, testing evidence, system design
```

`show_seats` materializes every seat for a show and has `UNIQUE (show_id, seat_id)`: one physical venue seat can have only one mutable state row per show. `expires_at` and `reserved_until` are intentionally separate. `expires_at` is a hold or current offer attempt's deadline; `reserved_until` is the fixed outer deadline for an offer cascade. A public hold may reclaim an expired `HELD` row, but may not take `OFFER_RESERVED` inventory until `reserved_until` has passed.

## API

The interactive specification is at [`/api/docs`](http://localhost:3000/api/docs) locally (and `/api/docs` on the live service).

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Auth | `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`; `GET /me` |
| Venue/admin | `GET/POST /api/v1/venues`, venue categories, bulk seats, and layouts |
| Events/shows | `GET/POST /api/v1/events`, `GET/PATCH /events/:id`, `GET/POST /events/:eventId/shows`, `GET /shows/:id` |
| Seat map and holds | `GET /api/v1/shows/:id/seatmap`; `POST /api/v1/holds`; `DELETE /api/v1/holds/:id` |
| Bookings | `POST /api/v1/bookings/confirm`, `POST /api/v1/bookings/:id/cancel`, `GET /api/v1/bookings/:id/ticket` |
| Waitlist/offers | `POST/GET /api/v1/shows/:showId/waitlist`; `GET /api/v1/waitlist/offers/:token`; `POST /api/v1/waitlist/offers/:token/accept` |

## Tests

Set `DATABASE_URL` to a disposable PostgreSQL test database, then run:

```powershell
npm test
npm run test:concurrency
npm run lint
```

The concurrency command exercises 50 parallel hold requests, overlapping multi-seat races, lazy expiry, and the offer-reservation boundary. CI runs that suite three consecutive times. See [testing evidence](docs/TESTING.md) for scenarios and falsification results.

## Why there is no Redis

Redis is not needed to make seats exclusive. PostgreSQL already owns durable seat state and supplies row locks, atomic guarded updates, transactions, and the unique constraint required here. A cache lock would create a second authority and introduce lock-expiry, reconciliation, and split-brain failure modes. The database predicate decides whether a seat is acquirable at write time; that remains correct if every scheduler, worker, cache, or process restarts. Redis could later serve non-authoritative caching or fan-out, but it is not on the booking correctness path.
