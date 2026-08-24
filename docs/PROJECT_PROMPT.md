# Ticket Booking System — Master Build Prompt

> **How to use this file:** it lives at `docs/PROJECT_PROMPT.md` and is imported by `CLAUDE.md`. Claude Code reads it when it needs the spec. It is written to be executed, not skimmed.

---

## 0. Role and mission

You are the lead engineer building a production-grade **ticket booking platform** for movies and concerts.

This is an evaluated deliverable. The graders are not scoring "does it work" — they are scoring **four hard problems** that most submissions get wrong:

1. Seat hold TTL and auto-release
2. Concurrency protection on simultaneous seat selection
3. Waitlist auto-assignment with a time-limited offer flow
4. Seat map data model and real-time status propagation

Everything else is table stakes. **Spend your engineering budget on those four and make them provably correct.** A test that fires 50 concurrent requests at one seat and asserts exactly one winner is worth more than ten extra screens.

### 0.1 Your working contract

- **Read `docs/BUILD_LOG.md` before every session.** It is the source of truth for what is done, in progress, and next. Never start work that isn't a task in it.
- **Update `docs/BUILD_LOG.md` after every task**: flip the status, fill in "Files touched" and "Verified by", append to the Decisions Ledger.
- **Update `docs/FILE_MANIFEST.md` whenever you create, delete or repurpose a file.**
- **Never leave a `TODO` in committed code.** Unfinished work is a build-log row, not a comment.
- **Every hard mechanism gets a test that fails if the mechanism is removed.** If deleting the `expires_at > now()` guard still passes your tests, your tests are wrong.
- **Commit and push after every completed task** (§0.2).
- **Comment for a reader who is learning the system** (§0.3). The owner will defend this design out loud.

### 0.2 Git discipline

Branch per phase (`phase/3-holds-concurrency`), merge to `main` when the phase audit passes.

```bash
npm run lint && npm test                                  # never push red
git add -A                                                # code AND docs together
git commit -m "feat(holds): atomic seat acquire via FOR UPDATE CTE [P3-2]"
git push origin phase/3-holds-concurrency
```

- Conventional Commits, always carrying the task ID in brackets. The log then reads as a narrative of the build — itself a signal to a reviewer.
- `BUILD_LOG.md` and `FILE_MANIFEST.md` updates go in the **same commit** as the code they describe.
- Tasks past ~40 minutes or ~8 files get an intermediate `wip:` push at the halfway mark.
- If a push fails, **stop and surface it immediately**. Never build on unpushed commits.
- Never force-push `main`. Never commit `.env`, `node_modules`, `dist`, or credentials.
- Tag each phase: `git tag v0.3.0-phase3 && git push --tags`.

Report the commit hash after every push.

### 0.3 Commenting standard

Write for someone fluent in JavaScript who has never seen a seat-hold system.

**File headers.** Every file opens with what it owns, what it deliberately does *not* own, who it collaborates with, and any invariant it upholds.

```js
/**
 * holds.queries.js
 *
 * Owns the raw SQL for seat acquisition and release. Exists as its own file because this
 * SQL is the single most important thing in the codebase — it deserves to be read alone.
 *
 * Does NOT own: hold lifecycle orchestration or socket broadcasting (holds.service.js).
 *
 * Invariant: acquireSeats() is all-or-nothing. It returns every requested seat, or none.
 */
```

**Exported functions** get a JSDoc block. Because we're in plain JS, JSDoc is also your type
safety — annotate `@param`, `@returns`, `@throws`, and any concurrency assumption the caller must
respect. Editors will surface these as real hints.

```js
/**
 * Atomically place a hold on every requested seat, or none of them.
 *
 * @param {import('pg').PoolClient} client - must already be inside a transaction
 * @param {{ showId: string, seatIds: string[], holdId: string, userId: string, ttlSeconds: number }} params
 * @returns {Promise<string[]>} seat ids actually held — caller MUST check length
 * @throws never; partial success is signalled by a short array, not an exception
 */
```

**Explain the WHY at every non-obvious line.** Anyone can see a line sets `expires_at`. Nobody can
see why it lives in the `WHERE` clause instead of a cron job.

```js
// WHY the expiry check is in the predicate rather than a scheduled job:
// A hold is expired the instant the clock passes expires_at. Encoding that here makes
// expiry a property of the data, not of a worker being alive. Kill every background
// process and seats still free themselves — the reconciler only materialises and
// broadcasts what is already logically true.
//
// WHY `ORDER BY seat_id` in the CTE:
// Two overlapping multi-seat requests ({A1,A2} and {A2,A3}) would otherwise take row
// locks in opposite orders and deadlock. Sorting makes them queue instead.
```

**Walkthrough blocks for the four hard mechanisms.** Above `holds.queries.js#acquireSeats`,
`holds.service.js#releaseHold`, `bookings.service.js#confirmBooking`, and
`offers.service.js#cascadeOffer`, write a numbered narration of the happy path **and what the loser
of a race experiences**. These four blocks are what a reviewer will actually read.

**Comment trade-offs, not just choices.**
`// WHY there is no distributed lock here: the row lock taken by the FOR UPDATE below is`
`// already the correctness boundary. A lock in a second datastore could only ever agree`
`// with it or be wrong. See the 'Why Postgres-only' section of the README.`

**Also required:** every index comment names the query it serves; every `.env.example` var says what
it controls and what breaks if it's wrong; every error code says when it's thrown and what the UI
should do; every migration has a header explaining the change and whether it's reversible.

**Not wanted:** comments restating the line below, JSDoc echoing parameter names, commented-out
code, or `TODO`. Noise makes good comments invisible.

---

## 2. What makes this submission extraordinary

Ten decisions that separate "a booking app" from "the one they remember." Each is cheap; together they are decisive.

| # | Decision | Why it wins |
|---|---|---|
| 1 | **Lazy expiry as the source of truth.** A hold is expired the instant `expires_at <= now()`, evaluated in the SQL predicate itself. The scheduler only *materialises* and *broadcasts*. | Correctness never depends on a cron job firing. If every background process crashes, seats still free themselves. The most sophisticated idea here — lead the write-up with it. |
| 2 | **Single-statement atomic hold** using a `FOR UPDATE` CTE with deterministic lock ordering by `seat_id`. | Impossible to double-hold, impossible to deadlock, no retry loop. Explain *why* READ COMMITTED suffices (§5.2). |
| 3 | **Three-layer TTL**: SQL predicate (authoritative) → `job_queue` delayed job written in the same transaction as the hold (timely) → 30s cron reconciler (durable sweep). All idempotent. | Defence in depth, and you can demo killing each layer. |
| 4 | **Transactional outbox for every email.** The booking row and the outbox row commit together; a worker drains it. | No email for a rolled-back booking. No lost email on a crash. The failure mode nobody else handles. |
| 5 | **Seats never return to the public pool during a waitlist offer.** Cancelled seat → `OFFER_RESERVED` under the offeree's name with its own TTL. | The naive version releases the seat and a random browser snipes it. Yours can't. |
| 6 | **Single-use HMAC offer tokens**, hashed at rest, with a cascade counter. | Time-limited link done properly, not a guessable `?bookingId=`. |
| 7 | **Explicit seat state machine** in one file with an illegal-transition guard. | A reviewer reads 40 lines and knows the model is sound. |
| 8 | **Scannable QR with a check-in endpoint** that marks a ticket used exactly once. | The brief only asks you to *generate* a QR. Closing the loop is the "oh, nice" moment. |
| 9 | **Concurrency proof suite** — 50 parallel holds, 20 parallel confirms, 10 users racing one offer. Runs in CI. | Turns a claim into evidence. |
| 10 | **Live seat-map presence** + optimistic selection with server reconciliation and a visible hold countdown. | Makes invisible backend work *feel* real in a 60-second demo. |

**Also build a `/demo` page** with buttons that trigger each mechanism on cue: *Simulate 50 concurrent holds*, *Force-expire this hold*, *Cancel a booking and watch the waitlist fire*. Graders are time-boxed. Hand them the proof.

---

## 3. Locked technology choices

Plain JavaScript, ESM (`"type": "module"`), Node 20+. No TypeScript, no build step on the server.

### 3.0 Hard environment constraints — read before choosing anything

The development machine is **Windows with 4 GB RAM and no Docker**. This is not a preference, it is
a limit. Therefore:

- **No Docker, no containers, no `docker-compose.yml`, no `testcontainers`.** Ever. Do not suggest
  them, do not add them as an "optional" path.
- **No Redis.** PostgreSQL is the only datastore. See §3.2 for how every Redis job is replaced.
- **One service to install and run: PostgreSQL.** Everything else is an npm package.
- Never assume server and client and tests can run simultaneously. Provide separate scripts.

### 3.1 The stack

| Layer | Choice | Rationale |
|---|---|---|
| Repo | npm workspaces: `server/`, `client/`, `shared/` | One `npm install`, shared constants |
| Backend | **Express 5** | Native async error handling |
| Database | **PostgreSQL 16 + `pg` (node-postgres)** | Raw SQL. The locking query is the centrepiece |
| Migrations | **`node-pg-migrate`**, SQL-based | Plain SQL up/down files, ordered, tracked |
| Realtime push from DB | **Postgres `LISTEN`/`NOTIFY`** | Replaces Redis keyspace events — and it's *transactional* |
| Background jobs | **`job_queue` table + `FOR UPDATE SKIP LOCKED`** | Replaces BullMQ. ~80 lines, no new service |
| Scheduler | **`node-cron`** | Drives the job poller and the reconcilers |
| Realtime to browser | **Socket.IO** (no adapter — single instance) | Rooms per show |
| Validation | **Zod** | One schema shared by server and client |
| Auth | `jsonwebtoken` + `argon2` + `cookie-parser` | Access 15m / refresh 7d, httpOnly cookies |
| Frontend | **React 18 + Vite + React Router 6** | Fast, familiar, low memory |
| Client state | TanStack Query + Zustand | Query for server cache, Zustand for seat selection |
| Styling | **Tailwind + Headless UI + lucide-react** | Hand-rolled components |
| Charts | Recharts | Organiser revenue dashboard |
| Email | **Nodemailer** + **EJS** templates. Dev: **Ethereal** (auto-generated inbox, preview URL, nothing to install). Prod: Brevo/Resend SMTP | No JSX on the server, no Mailhog container |
| QR | `qrcode` | PNG buffer, attached inline via CID |
| Testing | **Vitest** + Supertest against a **local `ticket_booking_test` database** | Real Postgres, truncated between tests. No containers |
| API docs | `swagger-jsdoc` + `swagger-ui-express` | JSDoc becomes live docs at `/api/docs` |
| Logging | `pino` + `pino-http` | Structured logs with request ids |
| Deploy | Render/Railway (API + managed Postgres), Vercel/Netlify (client) | Free tiers, one database, no Redis add-on |

### 3.2 Why Postgres-only is the *better* design — put this in the write-up

Dropping Redis is not a compromise forced by hardware; argue it as a deliberate choice, because it
genuinely is one.

| What Redis would have done | Postgres replacement | Why it's as good or better |
|---|---|---|
| Keyspace expiry → instant release notification | `pg_notify()` inside the transaction, a dedicated `LISTEN` client on the server | **NOTIFY is transactional** — it only fires if the transaction commits. A Redis broadcast can announce a seat release that then gets rolled back. This version cannot. |
| Distributed lock on seat selection | Nothing | The row lock was always the correctness boundary; the doc already said the Redis lock was only shedding load. Removing it removes a thing to explain, not a guarantee. |
| BullMQ delayed jobs | `job_queue` table, polled with `FOR UPDATE SKIP LOCKED` | Same claim-exactly-once semantics as BullMQ, using the identical primitive as the waitlist cascade. One pattern to learn, one pattern to defend. |
| Socket.IO Redis adapter | Not needed | Single instance. Note in the write-up that this is where Redis would re-enter if you scaled horizontally. |
| Sorted set for waitlist position | `ROW_NUMBER() OVER (ORDER BY enqueued_at)` | Source of truth and position come from the same query, so they can never disagree. The Redis mirror could drift. |

The headline sentence: **one datastore means one source of truth, one transaction boundary, and no
cross-system consistency problem.** That is a stronger architectural claim than "I added a cache."

### 3.3 The job queue

```sql
CREATE TABLE job_queue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,          -- HOLD_EXPIRY | OFFER_EXPIRY | OUTBOX_SEND
  payload    jsonb NOT NULL,
  run_at     timestamptz NOT NULL,   -- delayed execution
  status     text NOT NULL DEFAULT 'PENDING',  -- PENDING|RUNNING|DONE|FAILED|DEAD
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: the poller's claim query
CREATE INDEX idx_job_queue_claim ON job_queue(status, run_at) WHERE status = 'PENDING';
```

The poller runs every 2 seconds via `node-cron` and claims a batch atomically:

```sql
UPDATE job_queue
   SET status = 'RUNNING', attempts = attempts + 1
 WHERE id IN (
   SELECT id FROM job_queue
    WHERE status = 'PENDING' AND run_at <= now()
    ORDER BY run_at
    LIMIT 10
      FOR UPDATE SKIP LOCKED     -- two pollers never claim the same job
 )
RETURNING *;
```

On failure: `status = 'PENDING'`, `run_at = now() + backoff(attempts)`. After 5 attempts:
`status = 'DEAD'`, surfaced in `/health`. That is BullMQ's contract in one table and one query —
and it's the same `SKIP LOCKED` primitive as the waitlist cascade, so there's one idea to explain
instead of two.

### 3.4 Memory budget — 4 GB machine

- `pg.Pool` max **10** connections, not 20. Each backend costs real memory.
- Postgres config: `shared_buffers = 128MB`, `max_connections = 50`, `work_mem = 4MB`.
- Separate scripts: `npm run dev:server` and `npm run dev:client`. Only add a combined `dev` script
  using `npm-run-all` as a convenience — never assume both plus a browser plus tests fit at once.
- Tests run against the local Postgres; stop the dev server first. Say so in `docs/TESTING.md`.
- Seed data stays modest: venues of ~200 seats, not 2,000.
- No `--max-old-space-size` bumps. If something needs them, the design is wrong.

**JSDoc everywhere.** Since there's no compiler, JSDoc is your type documentation. Add `// @ts-check`
at the top of `holds`, `bookings`, `waitlist` and `offers` service files and keep a `jsconfig.json`
with `checkJs: true` — editor-level type checking on the files that matter, zero build cost.

---

## 4. Domain model

### 4.1 Roles

`ADMIN` (venues, seat layouts, categories) · `ORGANISER` (events, shows, pricing, revenue) · `CUSTOMER` (browse, book, waitlist, cancel).

Enforce with `requireAuth` then `requireRole(...)` middleware. **Ownership is a separate check**: an organiser has the ORGANISER role *and* must own the event. Test that explicitly — it's a commonly missed hole.

### 4.2 Schema

Written as migrations under `server/src/db/migrations/`. Every table and index carries a comment.

```sql
CREATE TYPE role_t          AS ENUM ('ADMIN','ORGANISER','CUSTOMER');
CREATE TYPE event_type_t    AS ENUM ('MOVIE','CONCERT');
CREATE TYPE show_status_t   AS ENUM ('SCHEDULED','CANCELLED','COMPLETED');
CREATE TYPE seat_state_t    AS ENUM ('AVAILABLE','HELD','OFFER_RESERVED','BOOKED','BLOCKED');
CREATE TYPE hold_status_t   AS ENUM ('ACTIVE','CONVERTED','RELEASED','EXPIRED');
CREATE TYPE booking_status_t AS ENUM ('PENDING','CONFIRMED','CANCELLED','EXPIRED');
CREATE TYPE waitlist_status_t AS ENUM ('WAITING','OFFERED','CONVERTED','EXPIRED','CANCELLED');
CREATE TYPE offer_status_t  AS ENUM ('PENDING','ACCEPTED','EXPIRED','SUPERSEDED');
CREATE TYPE outbox_status_t AS ENUM ('PENDING','SENT','FAILED','DEAD');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  phone         text,
  role          role_t NOT NULL DEFAULT 'CUSTOMER',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text NOT NULL,
  city        text NOT NULL,
  layout_meta jsonb NOT NULL DEFAULT '{}',  -- { rows, cols, aisleAfterCols:[5,12], stagePosition:'TOP' }
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_venues_city ON venues(city);  -- serves: browse filtered by city

CREATE TABLE seat_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name       text NOT NULL,                  -- 'Premium', 'Standard'
  color_hex  text NOT NULL DEFAULT '#6366f1',
  sort_order int  NOT NULL DEFAULT 0,
  UNIQUE (venue_id, name)
);

CREATE TABLE seats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES seat_categories(id),
  row_label     text NOT NULL,               -- 'A'
  seat_number   int  NOT NULL,               -- 12
  grid_row      int  NOT NULL,               -- render coordinates
  grid_col      int  NOT NULL,
  is_accessible boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (venue_id, row_label, seat_number),
  UNIQUE (venue_id, grid_row, grid_col)      -- no two seats render in the same cell
);

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id uuid NOT NULL REFERENCES users(id),
  title        text NOT NULL,
  type         event_type_t NOT NULL,
  description  text NOT NULL DEFAULT '',
  poster_url   text,
  language     text,
  genre        text,
  duration_min int NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_browse ON events(type, is_published);

CREATE TABLE shows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  venue_id          uuid NOT NULL REFERENCES venues(id),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  status            show_status_t NOT NULL DEFAULT 'SCHEDULED',
  hold_ttl_seconds  int NOT NULL DEFAULT 600,   -- configurable per show
  offer_ttl_seconds int NOT NULL DEFAULT 900
);
CREATE INDEX idx_shows_upcoming ON shows(starts_at, status);

CREATE TABLE show_prices (
  show_id     uuid NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories(id),
  price_cents int  NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (show_id, category_id)
);

CREATE TABLE seat_holds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id    uuid NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  status     hold_status_t NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_holds_sweep ON seat_holds(status, expires_at);

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text UNIQUE NOT NULL,          -- 'TB-7K2M9QX4'
  show_id         uuid NOT NULL REFERENCES shows(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  status          booking_status_t NOT NULL DEFAULT 'PENDING',
  subtotal_cents  int NOT NULL,
  fees_cents      int NOT NULL DEFAULT 0,
  total_cents     int NOT NULL,
  qr_token        text NOT NULL,
  idempotency_key text UNIQUE,
  checked_in_at   timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bookings_user ON bookings(user_id, created_at DESC);

/* THE critical table. One row per seat per show. The row IS the lock. */
CREATE TABLE show_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id         uuid NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_id         uuid NOT NULL REFERENCES seats(id),
  category_id     uuid NOT NULL REFERENCES seat_categories(id),
  state           seat_state_t NOT NULL DEFAULT 'AVAILABLE',
  hold_id         uuid REFERENCES seat_holds(id),
  held_by_user_id uuid REFERENCES users(id),
  expires_at      timestamptz,                  -- HELD: hold TTL. OFFER_RESERVED: current
                                                  -- cascade attempt's deadline, extended on
                                                  -- each cascade.
  reserved_until  timestamptz,                  -- OFFER_RESERVED only. Fixed end of the whole
                                                  -- cascade window, set once on entry, never
                                                  -- extended. The acquire predicate (§6.1)
                                                  -- checks THIS for OFFER_RESERVED, not
                                                  -- expires_at, so a public hold can never win
                                                  -- a seat while a cascade could still be live.
                                                  -- See Decisions Ledger D-14.
  booking_id      uuid REFERENCES bookings(id),
  version         int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (show_id, seat_id)                     -- makes double-allocation physically impossible
);
CREATE INDEX idx_show_seats_map    ON show_seats(show_id, state);
CREATE INDEX idx_show_seats_sweep  ON show_seats(state, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_show_seats_avail  ON show_seats(show_id, category_id, state);

/* Deliberate two-way link — be ready to defend this in review.
   show_seats.booking_id  = the CURRENT occupant, read on every seat-map render.
   booking_seats          = the historical record, and the only place the price
                            actually charged is stored. Prices change; a cancelled
                            booking must still show what the customer paid.
   On cancellation, show_seats.booking_id is cleared but booking_seats is kept. */
CREATE TABLE booking_seats (
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  show_seat_id uuid NOT NULL REFERENCES show_seats(id),
  price_cents  int NOT NULL,
  PRIMARY KEY (booking_id, show_seat_id)
);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid UNIQUE NOT NULL REFERENCES bookings(id),
  provider     text NOT NULL DEFAULT 'MOCK',
  status       text NOT NULL,                  -- AUTHORIZED | CAPTURED | REFUNDED
  amount_cents int NOT NULL,
  txn_ref      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waitlist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id     uuid NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  quantity    int NOT NULL DEFAULT 1,
  status      waitlist_status_t NOT NULL DEFAULT 'WAITING',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (show_id, category_id, user_id)
);
-- serves: FIFO head lookup during the cancellation cascade
CREATE INDEX idx_waitlist_fifo ON waitlist_entries(show_id, category_id, status, enqueued_at);

CREATE TABLE waitlist_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_entry_id uuid NOT NULL REFERENCES waitlist_entries(id),
  show_seat_ids     uuid[] NOT NULL,       -- array, so no FK enforcement; validate in offers.service.js
  token_hash        text UNIQUE NOT NULL,       -- sha256 of the raw token; raw is never stored
  status            offer_status_t NOT NULL DEFAULT 'PENDING',
  attempt_no        int NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_offers_sweep ON waitlist_offers(status, expires_at);

CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,                   -- BOOKING_CONFIRMED | WAITLIST_OFFER | ...
  payload      jsonb NOT NULL,
  status       outbox_status_t NOT NULL DEFAULT 'PENDING',
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_drain ON outbox_events(status, available_at);

/* Replaces BullMQ. Claimed with FOR UPDATE SKIP LOCKED — see §3.3. */
CREATE TABLE job_queue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,                     -- HOLD_EXPIRY | OFFER_EXPIRY | OUTBOX_SEND
  payload    jsonb NOT NULL,
  run_at     timestamptz NOT NULL,              -- delayed execution
  status     text NOT NULL DEFAULT 'PENDING',   -- PENDING|RUNNING|DONE|FAILED|DEAD
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: the poller's claim query, which runs every 2s
CREATE INDEX idx_job_queue_claim ON job_queue(status, run_at) WHERE status = 'PENDING';

CREATE TABLE ticket_scans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  result     text NOT NULL,                     -- VALID | ALREADY_USED | INVALID | WRONG_SHOW
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_by uuid REFERENCES users(id)
);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
```

### 4.3 Seat state machine

Lives in `shared/seatStates.js` and is imported by **both** server and client, so the UI colour map and the server guard can never drift.

```
AVAILABLE      → HELD            (customer selects)
AVAILABLE      → BLOCKED         (admin)
HELD           → BOOKED          (checkout confirmed, hold still live)
HELD           → AVAILABLE       (TTL expired | released | checkout abandoned)
BOOKED         → AVAILABLE       (cancelled, no waitlist for that category)
BOOKED         → OFFER_RESERVED  (cancelled, waitlist non-empty)
OFFER_RESERVED → BOOKED          (offeree completed in time)
OFFER_RESERVED → OFFER_RESERVED  (offer expired, cascade to next in line)
OFFER_RESERVED → AVAILABLE       (queue drained or max cascade attempts hit)
BLOCKED        → AVAILABLE       (admin)
```

Anything else throws `IllegalSeatTransitionError`. Unit-test the full matrix.

---

## 5. The seat hold and TTL mechanism

### 5.1 The core principle — state this first in your write-up

> **A hold is expired because the clock says so, not because a job said so.**

Every read and every write predicate carries `AND (state <> 'HELD' OR expires_at > now())`. The scheduler's job is only to *materialise* the logical truth into a stored row and *broadcast* it. If the poller and the cron are both dead, the system is still **correct** — just less live.

### 5.2 Three layers

**Layer 1 — Database predicate (authoritative).** `expires_at` on `show_seats`. Availability queries and the acquire predicate both treat an expired hold as available. Nothing to run, nothing to fail.

**Layer 2 — `job_queue` delayed job (timely release).** On hold creation, in the **same transaction**, insert `job_queue { type: 'HOLD_EXPIRY', payload: { holdId }, run_at: now() + ttl }`. The poller picks it up within ~2 seconds of expiry and calls `releaseHold(holdId, 'TTL')`. Because the job row and the hold row commit together, a hold can never exist without its expiry job — something a separate queue service cannot guarantee.

**Layer 3 — `node-cron` reconciler (durability).** Every 30s, regardless of the job queue:

```sql
UPDATE show_seats
   SET state = 'AVAILABLE', hold_id = NULL, held_by_user_id = NULL,
       expires_at = NULL, version = version + 1, updated_at = now()
 WHERE state = 'HELD' AND expires_at <= now()
RETURNING show_id, seat_id;
```

Every path calls the same idempotent `releaseHold()`. Releasing an already-released hold returns `{ released: 0 }` — never an error. Three layers racing to release the same hold is the **normal** case, not an edge case.

### 5.3 Checkout abandonment

"Abandonment" is not an event you can detect — it is the *absence* of a confirm before `expires_at`. It therefore needs no special code path: **the TTL is the abandonment handler.** Say this explicitly in the write-up; it shows you understood the problem rather than bolting on a `beforeunload` hack.

Additionally implement a best-effort `DELETE /api/v1/holds/:id` fired via `navigator.sendBeacon` on tab close — a fast path, never a correctness dependency.

---

## 6. Concurrency protection

### 6.1 The atomic acquire

One statement. No read-then-write. No application-level check-then-act.

```sql
-- server/src/modules/holds/holds.queries.js
WITH candidates AS (
  SELECT id
    FROM show_seats
   WHERE show_id = $1 AND seat_id = ANY($2::uuid[])
   ORDER BY seat_id           -- deterministic lock order ⇒ no deadlocks
     FOR UPDATE
)
UPDATE show_seats s
   SET state = 'HELD',
       hold_id = $3,
       held_by_user_id = $4,
       expires_at = now() + make_interval(secs => $5),
       reserved_until = NULL,        -- clears any stale OFFER_RESERVED bound; HELD only ever uses expires_at
       version = s.version + 1,
       updated_at = now()
  FROM candidates c
 WHERE s.id = c.id
   AND ( s.state = 'AVAILABLE'
      OR (s.state = 'HELD'           AND s.expires_at     <= now())
      OR (s.state = 'OFFER_RESERVED' AND s.reserved_until <= now()) )
RETURNING s.seat_id;
```

**Why `reserved_until`, not `expires_at`, gates the `OFFER_RESERVED` branch (D-14):** the original predicate checked `expires_at`, which is the *current cascade attempt's* deadline — the instant one attempt lapsed, a public hold could snipe the seat mid-cascade, before the next waitlisted user had been offered it. That contradicts §7.2/D-7 (seats never re-enter the public pool during an offer window). `reserved_until` is fixed once, on first entry to `OFFER_RESERVED`, at `now() + (offer_ttl_seconds × WAITLIST_MAX_CASCADE_ATTEMPTS) + 60s` — a hard upper bound on how long *any* legitimate cascade can run (§7.2, §7.4). A public hold can only win the seat once that whole window has passed, by which point no legitimate cascade can still be in flight.

If `result.rowCount !== seatIds.length` → **`ROLLBACK` the whole transaction** and return `409 SEATS_UNAVAILABLE` with the conflicting seat labels so the UI can flash them red. All-or-nothing: never partially hold.

### 6.2 Why READ COMMITTED is sufficient — put this paragraph in the write-up

Under READ COMMITTED, when `UPDATE` blocks on a row lock held by a concurrent transaction, Postgres does not fail — it waits, and on release **re-evaluates the `WHERE` clause against the newly committed version of the row**. So the loser of a race re-reads `state = 'HELD'`, fails its predicate, and simply doesn't update that row. `rowCount` comes back short, we roll back, and the caller gets a clean 409. No `SERIALIZABLE`, no retry loop, no lost update. Ordering the `FOR UPDATE` by `seat_id` means two transactions requesting overlapping seat sets always take locks in the same order, so they queue instead of deadlocking.

### 6.3 Transaction handling in `pg`

There is no ORM here, so write the helper once and use it everywhere:

```js
// server/src/db/withTransaction.js
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();      // ALWAYS — a leaked client exhausts the pool under load
  }
}
```

**Rule: any function that runs SQL takes a `client` parameter.** Never call `pool.query` inside a transaction — you'd get a different connection and silently escape the transaction. This is the single easiest way to break correctness with `pg`; comment it at the top of every `*.queries.js` file.

### 6.4 Defence in depth

- **No application-level lock, deliberately.** The `FOR UPDATE` row lock *is* the correctness boundary. A lock held anywhere else could only agree with it or be wrong, and would add a failure mode. Being able to say why you left it out is worth more than adding it — cover this in the write-up.
- **`UNIQUE (show_id, seat_id)`** means a seat physically cannot have two allocation rows.
- **Idempotency keys** on `POST /bookings/confirm`. Replay returns the original booking.
- **Rate limit** hold creation to 10/min/user via `express-rate-limit`.

### 6.5 Confirming the booking

```sql
UPDATE show_seats
   SET state = 'BOOKED', booking_id = $1, expires_at = NULL, hold_id = NULL,
       version = version + 1, updated_at = now()
 WHERE hold_id = $2 AND state = 'HELD' AND expires_at > now()
RETURNING id, category_id;
```

`rowCount` must equal the hold's seat count, else roll back with `410 HOLD_EXPIRED`. The `expires_at > now()` check closes the race where the TTL fires mid-checkout.

### 6.6 Required proof tests

| Test | Assertion | Lives at |
|---|---|---|
| 50 parallel `POST /holds` for seat A1 | exactly 1 × `201`, 49 × `409`; DB has exactly one `HELD` row | `tests/e2e/concurrency.test.js` (P3-9) |
| 20 parallel confirms of one hold | exactly 1 booking created | `tests/e2e/bookingFlow.test.js` (Phase 4 — needs `bookings.service.js#confirmBooking`, which doesn't exist yet as of P3-9) |
| Overlapping multi-seat holds `{A1,A2}` vs `{A2,A3}` | exactly one succeeds; loser holds **zero** seats | `tests/e2e/concurrency.test.js` (P3-9) |
| Hold expiry with all workers stopped | `GET /shows/:id/seatmap` still reports `AVAILABLE` | `tests/e2e/holdExpiry.test.js` (P3-9) |
| 10 waitlisted users racing one offer | 1 conversion, 9 × `410 OFFER_INVALID` | `tests/e2e/waitlist.test.js` (Phase 5 — needs the waitlist/offers module, which doesn't exist yet as of P3-9) |
| Confirm at `expires_at + 1ms` | `410 HOLD_EXPIRED`, seat not booked | `tests/e2e/bookingFlow.test.js` (Phase 4 — same reason as the row above) |
| Public `POST /holds` on an `OFFER_RESERVED` seat after its current `expires_at` but before `reserved_until` (D-14) | `409 SEATS_UNAVAILABLE`; seat stays `OFFER_RESERVED`, not reclaimed — proves offer exclusivity survives a stale per-attempt deadline | `tests/e2e/concurrency.test.js` (P3-9) |

Three of these six needed a module later phases haven't built yet as of P3-9 (bookings, waitlist/
offers) — deferred to the phase that builds it, not dropped; tracked explicitly in
`docs/BUILD_LOG.md`'s P3-9 row rather than silently left off this table.

Run against a **local `ticket_booking_test` database** — the real Postgres you already have, with tables truncated between tests. Never mock the pool: a mock has no row locks, so a mocked race test proves nothing. Stop the dev server before running these; 4 GB does not stretch to both.

---

## 7. Waitlist and time-limited offers

### 7.1 Joining

`POST /api/v1/shows/:showId/waitlist { categoryId, quantity }` — allowed only when that category has zero effectively-available seats. Unique on `(show_id, category_id, user_id)`. Response includes live position.

Position comes from the same table that holds the queue, so the two can never disagree:

```sql
SELECT position, total FROM (
  SELECT user_id,
         ROW_NUMBER() OVER (ORDER BY enqueued_at) AS position,
         COUNT(*) OVER ()                        AS total
    FROM waitlist_entries
   WHERE show_id = $1 AND category_id = $2 AND status = 'WAITING'
) q WHERE user_id = $3;
```

The index `idx_waitlist_fifo` covers this. "You are #7 of 23" in one query, no second datastore to drift out of sync.

### 7.2 The cancellation → offer flow

```
Customer cancels booking
  └─ TX: booking→CANCELLED, payment→REFUNDED, freed seats grouped by category_id
      └─ for each category group:
          ├─ queue empty  → seats → AVAILABLE, broadcast seat.released
          └─ queue head   → seats → OFFER_RESERVED
                            expires_at     = now + offer_ttl                              (this attempt's deadline)
                            reserved_until = now + (offer_ttl × MAX_CASCADE) + 60s grace   (set ONCE, D-14)
                            insert waitlist_offers { token_hash, attempt_no: 1 }
                            entry.status = 'OFFERED'
                            insert outbox_events WAITLIST_OFFER   ← same transaction
      └─ same TX: insert job_queue { type:'OFFER_EXPIRY', run_at: now() + offer_ttl }
      └─ same TX: pg_notify('seat_changes', ...)  ← fires only if the TX commits
```

Seats **never** re-enter the public pool during an offer window. That is the whole point — and it's `reserved_until`, not `expires_at`, that the acquire predicate (§6.1) checks to enforce it, because `expires_at` moves on every cascade attempt while `reserved_until` doesn't (D-14).

### 7.3 The token

```js
const raw = `${offerId}.${crypto.randomBytes(32).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');  // stored
const link = `${WEB_URL}/waitlist/claim/${raw}`;                          // emailed, never stored
```

`GET /waitlist/offers/:token` validates hash, `status === 'PENDING'`, `expires_at > now()`, and returns seats, price, and seconds remaining.
`POST /waitlist/offers/:token/accept` converts `OFFER_RESERVED → BOOKED` inside the same guarded transaction shape as §6.5, marks the offer `ACCEPTED` and the entry `CONVERTED`. Single-use: a second accept gets `410`.

### 7.4 Cascade

On `offer-expiry` (or explicit decline):

```sql
SELECT * FROM waitlist_entries
 WHERE show_id = $1 AND category_id = $2 AND status = 'WAITING'
 ORDER BY enqueued_at ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED;
```

If a next entry exists and `attempt_no < MAX_CASCADE (5)`: reuse the same `OFFER_RESERVED` seats, mint a new token, `attempt_no + 1`, new `expires_at = now() + offer_ttl`. **`reserved_until` is never touched after cascade attempt 1** (D-14) — it is the fixed outer bound the whole cascade must finish inside, not a per-attempt deadline, and re-extending it on every cascade would reopen the exact hole D-14 closes. Otherwise (queue drained or `MAX_CASCADE` reached) release the seats to `AVAILABLE`, clearing both `expires_at` and `reserved_until`, and broadcast.

`SKIP LOCKED` stops two concurrent cascades offering to the same person. `MAX_CASCADE` bounds how long seats can be locked behind a queue of inactive users — a bound most people forget. Mention it.

### 7.5 Emails

Four EJS templates, all via the outbox: **Booking Confirmed** (QR attached), **Waitlist Offer** (countdown + claim button), **Booking Cancelled** (refund summary), **Offer Expired** (courtesy).

---

## 8. QR codes and check-in

```js
const qrToken = jwt.sign(
  { ref: booking.reference, sid: booking.show_id, n: seatCount },
  env.QR_SIGNING_SECRET,               // distinct from the auth secret
  { expiresIn: '30d', jwtid: booking.id }
);
const png = await QRCode.toBuffer(qrToken, { errorCorrectionLevel: 'H', width: 512 });
```

Attach inline via CID so it renders in-client, and store the token for re-download at `GET /bookings/:id/ticket`.

`POST /api/v1/tickets/verify { qrToken }` (ORGANISER/ADMIN) → verify signature → load booking → check `status = 'CONFIRMED'`, show matches, `checked_in_at IS NULL` → set `checked_in_at`, write `ticket_scans`. A second scan returns `ALREADY_USED` with the original scan time. **A ticket is single-use and the system proves it.**

---

## 9. API surface

Base `/api/v1`. Envelope: `{ success, data, error: { code, message, details } }`. Swagger at `/api/docs`, generated from JSDoc comments on the route files.

```
POST   /auth/register                     { email, password, name, role? }
POST   /auth/login                        → sets httpOnly cookies
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me

# ADMIN
POST   /venues                            { name, address, city, layoutMeta }
POST   /venues/:id/categories             { name, colorHex, sortOrder }
POST   /venues/:id/seats/bulk             { rows: [{ rowLabel, count, categoryId, gridRow }] }
GET    /venues/:id/layout

# ORGANISER
POST   /events                            { title, type, description, durationMin, ... }
PATCH  /events/:id                        (ownership-guarded)
POST   /events/:id/shows                  { venueId, startsAt, holdTtlSeconds?, prices[] }
POST   /shows/:id/publish                 → materialises show_seats from the venue layout
GET    /events/:id/summary                → sold, revenue, occupancy %, waitlist depth
GET    /shows/:id/bookings                → paginated manifest

# PUBLIC / CUSTOMER
GET    /events                            ?type&city&dateFrom&dateTo&q&page
GET    /events/:id
GET    /shows/:id
GET    /shows/:id/seatmap                 → grid + per-seat effective state + legend
GET    /shows/:id/availability            → per-category counts (drives the waitlist CTA)

POST   /holds                             { showId, seatIds[] }        → 201 | 409
GET    /holds/:id
DELETE /holds/:id                         (explicit release / sendBeacon)

POST   /bookings/confirm                  { holdId, customer{} }  Idempotency-Key header
GET    /bookings                          → own history
GET    /bookings/:id
GET    /bookings/:id/ticket               → PDF
POST   /bookings/:id/cancel               → triggers the waitlist flow

POST   /shows/:id/waitlist                { categoryId, quantity }
GET    /shows/:id/waitlist/me             → { position, total, status }
DELETE /shows/:id/waitlist
GET    /waitlist/offers/:token            → public, token-authenticated
POST   /waitlist/offers/:token/accept
POST   /waitlist/offers/:token/decline    → immediate cascade

POST   /tickets/verify                    { qrToken }   (ORGANISER/ADMIN)

GET    /health                            → { db, jobQueue: {pending, dead}, outboxBacklog }
```

**Error codes** (stable, in `shared/errors.js`): `SEATS_UNAVAILABLE`, `HOLD_EXPIRED`, `HOLD_NOT_FOUND`, `OFFER_INVALID`, `OFFER_EXPIRED`, `ALREADY_WAITLISTED`, `SHOW_NOT_SELLABLE`, `TICKET_ALREADY_USED`, `ILLEGAL_SEAT_TRANSITION`, `IDEMPOTENT_REPLAY`.

---

## 10. Realtime contract

Namespace `/rt`. Client joins room `show:{showId}` when the seat map mounts. Event names live in `shared/socketEvents.js` — never a raw string in either codebase.

**How a database change reaches a browser.** Services never emit directly from business logic. They
call `pg_notify('seat_changes', payload)` **inside the transaction**. A single dedicated `pg` client
holds an open `LISTEN seat_changes` and forwards whatever arrives to the right Socket.IO room.

This ordering matters and belongs in the write-up: **`NOTIFY` only delivers if the transaction
commits.** A broadcast can never announce a seat release that then rolls back. Emitting directly
from a service — or from a second datastore — has no such guarantee. It also means the 30s
reconciler and the job poller get realtime for free: they change rows, the notification follows.

| Event | Payload | Emitted when |
|---|---|---|
| `seat.held` | `{ showId, seatIds[], expiresAt }` | hold acquired |
| `seat.released` | `{ showId, seatIds[], reason }` | any release (`TTL`/`MANUAL`/`CANCELLED`/`OFFER_LAPSED`) |
| `seat.booked` | `{ showId, seatIds[] }` | booking confirmed |
| `seat.offerReserved` | `{ showId, seatIds[] }` | cancelled seat enters an offer window |
| `availability.changed` | `{ showId, byCategory }` | any count change |
| `presence.updated` | `{ showId, viewers }` | join/leave, throttled 2s |
| `waitlist.positionChanged` | `{ showId, categoryId, position }` | to that user's room |

Never trust the socket alone. On reconnect the client refetches `GET /shows/:id/seatmap` and hard-reconciles. Socket is an accelerator; HTTP is the truth.

---

## 11. Frontend requirements

React 18 + Vite + React Router 6. Routes: `/`, `/events`, `/events/:id`, `/shows/:id`, `/checkout/:holdId`, `/bookings`, `/bookings/:id`, `/waitlist/claim/:token`, `/organiser/*`, `/admin/*`, `/scan`, `/demo`.

**Seat map** — the centrepiece. CSS grid from `grid_row`/`grid_col`, aisles from `layoutMeta.aisleAfterCols`, screen/stage marker, category colour legend, hover tooltip (row, seat, category, price), pinch-zoom and pan on mobile, keyboard-navigable with ARIA labels, max 6 seats. States: available / selected / held-by-other (hatched) / booked (solid grey) / your-hold (pulsing outline with countdown).

**Checkout** — sticky summary, live `mm:ss` countdown that turns amber at 60s and red at 15s, mock payment step, success screen showing the QR immediately (don't make them wait for email).

**Sold out** → seat map replaced by a waitlist card per category with live queue depth and position over the socket.

**Claim page** `/waitlist/claim/:token` — one screen: seats offered, price, large countdown, Accept, Decline.

**Dashboards** — organiser: revenue, tickets sold, occupancy, waitlist depth, per-category breakdown (Recharts), CSV export. Admin: venue designer with a grid editor for assigning categories to rows.

**`/demo`** — the grader shortcut from §2.

Accessibility: WCAG AA contrast, full keyboard path through seat selection, `aria-live` announcements on seat state changes. Dark mode. Skeleton loaders, empty states, error boundaries — polish is a scored signal.

---

## 12. Configuration

Every value below goes in `.env.example` with a comment saying what it controls and what breaks if it's wrong. No magic numbers in code.

```
NODE_ENV, PORT, API_URL, WEB_URL
DATABASE_URL, PGPOOL_MAX=10          # keep low: 4 GB dev machine
JOB_POLL_INTERVAL_MS=2000            # how soon after expiry a hold is materialised
JOB_MAX_ATTEMPTS=5                   # then the job is marked DEAD and surfaced in /health
JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, JWT_ACCESS_TTL=15m, JWT_REFRESH_TTL=7d
QR_SIGNING_SECRET
SEAT_HOLD_TTL_SECONDS=600
WAITLIST_OFFER_TTL_SECONDS=900
WAITLIST_MAX_CASCADE_ATTEMPTS=5
# show_seats.reserved_until is NOT its own env var — it's derived once, on entry to
# OFFER_RESERVED, as now() + (WAITLIST_OFFER_TTL_SECONDS * WAITLIST_MAX_CASCADE_ATTEMPTS) + 60s
# grace. Raising WAITLIST_MAX_CASCADE_ATTEMPTS lengthens how long a seat can stay off the public
# market by design — see D-14.
HOLD_RECONCILER_CRON=*/30 * * * * *
OUTBOX_RECONCILER_CRON=*/60 * * * * *   # sweeps outbox rows whose job row was lost
MAX_SEATS_PER_BOOKING=6
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM   # leave blank in dev: Ethereal auto-creates an account
BOOKING_FEE_PERCENT=0
RATE_LIMIT_HOLD_PER_MIN=10
```

Validate with Zod in `server/src/config/env.js` at boot. **Fail fast and loudly** on a missing variable — never start half-configured.

---

## 13. Deliverables checklist

- [ ] `README.md` — quickstart (install Postgres → `createdb` → `npm install` → `npm run db:migrate` → `npm run db:seed` → `npm run dev`), architecture diagram, env table, API reference, DB schema/ERD, prose on hold TTL / concurrency / waitlist, **and a "Why there is no Redis" section arguing §3.2 as a deliberate choice**
- [ ] `.env.example` — complete and commented
- [ ] `docs/SYSTEM_DESIGN.md` — **≤800 words** on TTL, concurrency, waitlist auto-assignment, time-limited offers. Lead with §5.1 and §6.2. Count the words.
- [ ] `docs/API.md` + live Swagger
- [ ] `docs/DB_SCHEMA.md` with a Mermaid ERD and index rationale
- [ ] `docs/SEQUENCE_DIAGRAMS.md` — Mermaid for hold→book, TTL expiry, cancel→cascade
- [ ] Seed script: 3 venues, 8 events, 20 shows, one deliberately sold-out show with a pre-populated waitlist, users for all three roles
- [ ] CI: lint, unit, e2e on push
- [ ] Deployed API + client, seeded and warm
- [ ] `DEMO.md` — grader script with credentials and a 5-minute walkthrough
- [ ] Zipped source, `node_modules` and `.env` excluded

---

## 14. Definition of done

A task is done when **all** of the following are true:

- [ ] Lint passes with zero warnings; `// @ts-check` files have no JSDoc type errors
- [ ] Tests cover the happy path **and the race**
- [ ] The endpoint appears in Swagger with example request/response
- [ ] The UI handles loading, empty, and error states
- [ ] File header, JSDoc blocks, and WHY-comments written (§0.3)
- [ ] `BUILD_LOG.md` and `FILE_MANIFEST.md` updated **in the same commit**
- [ ] Committed with a conventional message carrying the task ID
- [ ] **Pushed**, and the commit hash reported

**If you must cut scope, cut screens — never §5, §6, or §7.** Those three sections are the grade.

---

## 15. Session kickoff

1. Read `docs/BUILD_LOG.md` and confirm the next unstarted task.
2. State your plan in 3–5 bullets.
3. Implement it.
4. Run the relevant tests and paste the output.
5. Update `BUILD_LOG.md` and `FILE_MANIFEST.md`, commit, push, report the hash.

Begin at **Phase 0, task P0-1**.