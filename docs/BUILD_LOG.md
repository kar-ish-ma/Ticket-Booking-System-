# Ticket Booking System — Build Log

> **The single source of truth for what is done, in flight, and next.** Read this at the start of every session; update it at the end of every task. Nothing gets built that isn't a row here.

**Status key:** ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked · ❌ Dropped (with reason)

**Task ID format:** `P{phase}-{n}`. Reference the ID in every commit: `feat(holds): atomic acquire [P3-2]`

**Stack:** Node 20 + Express 5 + PostgreSQL (`pg`, raw SQL) · React 18 + Vite · plain JavaScript, ESM.

**No Docker, no Redis, no containers.** PostgreSQL is the only service. Dev machine: Windows, 4 GB RAM.

### Environment status (already done, do not redo)

| Item | Status |
|---|---|
| PostgreSQL 16.3 | ✅ installed, running as a Windows service |
| Databases `ticket_booking`, `ticket_booking_test` | ✅ created |
| `postgres` password | ✅ set; `pg_hba.conf` back on `scram-sha-256` |
| Node 22.19 | ✅ |
| Git 2.51 | ✅ |
| Claude Code | ✅ via VS Code extension |

`DATABASE_URL=postgresql://postgres:<password>@localhost:5432/ticket_booking`

---

## Progress at a glance

| Phase | Theme | Tasks | Done |
|---|---|---|---|
| 0 | Foundation and tooling | 7 | 1/7 |
| 1 | Database and auth | 7 | 0/7 |
| 2 | Venues, events, shows, seat map | 7 | 0/7 |
| 3 | **Seat holds, TTL, concurrency** ⭐ | 9 | 0/9 |
| 4 | Booking, QR, email outbox | 8 | 0/8 |
| 5 | **Waitlist and time-limited offers** ⭐ | 8 | 0/8 |
| 6 | Realtime seat map | 5 | 0/5 |
| 7 | React frontend | 10 | 0/10 |
| 8 | Reports, admin, check-in | 5 | 0/5 |
| 9 | Hardening and proof | 6 | 0/6 |
| 10 | Docs, deploy, demo | 7 | 0/7 |
| | **Total** | **79** | **1/79** |

---

## Phase 0 — Foundation and tooling

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P0-1 | npm workspaces: `server/`, `client/`, `shared/`; ESM everywhere | ✅ | `package.json` (root, `server/`, `client/`, `shared/`), `.gitignore`, `docs/FILE_MANIFEST.md` (relocated from repo root) | `npm install` at root: 0 vulnerabilities, `npm ls --workspaces` resolves all three via symlink | |
| P0-2 | ESLint + Prettier + `eslint-plugin-jsdoc`; `jsconfig.json` with `checkJs` | ⬜ | `.eslintrc.json`, `jsconfig.json` | `npm run lint` zero warnings | |
| P0-3 | ~~Install Postgres~~ **already done by hand** — Postgres 16.3 running, `ticket_booking` + `ticket_booking_test` created, password set. Remaining: verify `shared_buffers=128MB`/`max_connections=50` in `postgresql.conf`, add `.gitattributes` for LF endings, and write the setup steps into `docs/DEPLOYMENT.md` so a grader can reproduce them | ⬜ | `.gitattributes`, `docs/DEPLOYMENT.md` | `SHOW shared_buffers;` returns 128MB; `psql -l` shows both DBs | |
| P0-4 | Express app skeleton: helmet, CORS+credentials, cookie-parser, `pino-http`, error handler last | ⬜ | `server/src/app.js`, `index.js` | `GET /health` → 200 | |
| P0-5 | Zod env validation; `.env.example` written first, fully commented | ⬜ | `server/src/config/env.js`, `.env.example` | Boot fails loudly with a var removed | |
| P0-6 | Swagger via `swagger-jsdoc` at `/api/docs` | ⬜ | `server/src/config/swagger.js` | Page renders | |
| P0-7 | CI workflow: install → lint → test against GitHub's Postgres service container (Linux runners only — never the dev machine) | ⬜ | `.github/workflows/ci.yml` | Green on first push | |

**Exit criteria:** `npm run dev:server` gives a booting API with Swagger and a passing health check, with only Postgres installed.

---

## Phase 1 — Database and auth

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P1-1 | `node-pg-migrate` set up; migrations 001–002 (enums, users, venues, categories, seats, events, shows) | ⬜ | `server/src/db/migrations/00{1,2}_*.sql` | `npm run db:migrate` clean, `down` works | |
| P1-2 | Migrations 003–006 (`show_seats`, holds, bookings, waitlist, outbox, audit) with all indexes commented | ⬜ | `migrations/00{3,4,5,6}_*.sql` | `\d show_seats` shows `UNIQUE (show_id, seat_id)` | |
| P1-3 | ⭐ `pool.js` + `withTransaction.js` with statement timeout and guaranteed `client.release()` | ⬜ | `server/src/db/*` | Unit test: throw inside → ROLLBACK, pool not leaked | |
| P1-4 | ⭐ `job_queue` table + `enqueueJob(client, ...)` + poller with `FOR UPDATE SKIP LOCKED`, backoff, DEAD after N attempts | ⬜ | `migrations/007_job_queue.sql`, `queue/enqueue.js`, `queue/poller.js` | Two pollers race one job → claimed once | |
| P1-5 | Auth: register, login (argon2), access+refresh httpOnly cookies, rotation with reuse detection | ⬜ | `server/src/modules/auth/*` | `tests/e2e/auth.test.js` | |
| P1-6 | `requireAuth`, `requireRole`, `requireOwnership` middleware | ⬜ | `server/src/middleware/*` | Customer → organiser route = 403; organiser → someone else's event = 403 | |
| P1-7 | Seed skeleton: users for all three roles; idempotent | ⬜ | `server/src/db/seed.js` | `npm run db:seed` twice, no error | |

**Exit criteria:** Three roles log in; role **and ownership** are enforced and tested.

---

## Phase 2 — Venues, events, shows, seat map

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P2-1 | Venue CRUD with `layout_meta` (rows, cols, aisles, stage position) | ⬜ | `modules/venues/*` | E2E CRUD | |
| P2-2 | Seat categories per venue with colour and sort order | ⬜ | `modules/venues/*` | `UNIQUE (venue_id, name)` enforced | |
| P2-3 | Bulk seat creation from a row spec; reject duplicate grid coordinates | ⬜ | `venues.service.js`, `venues.queries.js` | 200-seat venue in one call | |
| P2-4 | Event CRUD (ownership-guarded) + public browse with filters and pagination | ⬜ | `modules/events/*` | Filter combinations tested | |
| P2-5 | Show creation with per-category pricing and per-show `hold_ttl_seconds` | ⬜ | `modules/shows/*` | Prices unique per category | |
| P2-6 | ⭐ `publishShow()` materialises one `show_seats` row per venue seat, one batched insert in a transaction | ⬜ | `shows.service.js`, `shows.queries.js` | 200 seats → 200 rows, all `AVAILABLE` | |
| P2-7 | ⭐ `GET /shows/:id/seatmap` returning **effective** state (expired HELD ⇒ available) | ⬜ | `modules/seatmap/*` | Test: manually stale HELD row reads as available | |

**Exit criteria:** A published show returns a complete seat map with live-derived states.

---

## Phase 3 — Seat holds, TTL, concurrency ⭐ **HIGHEST VALUE**

> Budget the most time here. Do not move to Phase 4 until every test in P3-9 is green three runs in a row.

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P3-1 | 🔒 Seat state machine: transition map in `shared/seatStates.js`, `assertTransition()` on the server | ⬜ | `shared/seatStates.js`, `seatState.machine.js` | Full matrix unit test | |
| P3-2 | ⭐ Atomic acquire: `FOR UPDATE` CTE ordered by `seat_id`, expired-hold reclaim in the predicate | ⬜ | `holds.queries.js` | Raw SQL test asserts `rowCount` | |
| P3-3 | ⭐ `createHold()`: all-or-nothing, ROLLBACK on partial, 409 with conflicting seat labels | ⬜ | `holds.service.js`, `holds.controller.js` | E2E: overlapping sets → loser holds zero | |
| P3-4 | ⭐ Idempotent `releaseHold(holdId, reason)` — double release is a no-op, never a throw | ⬜ | `holds.service.js` | Called 3× → one broadcast, no error | |
| P3-5 | ⭐ Layer 2: `HOLD_EXPIRY` job enqueued **in the same transaction** as the hold | ⬜ | `holds.service.js`, `queue/handlers/holdExpiry.js` | No hold can exist without its job row; release within ~2s of TTL | |
| P3-6 | ⭐ `pg_notify` publisher + `LISTEN` client bridging DB changes to Socket.IO rooms | ⬜ | `notify/publisher.js`, `notify/listener.js` | Rolled-back TX broadcasts nothing — the key test | |
| P3-7 | Layer 3: `node-cron` 30s reconciler sweeping expired holds, independent of the poller | ⬜ | `jobs/holdReconciler.job.js` | Stale row swept within 30s with the poller stopped | |
| P3-8 | Write the "Why there is no distributed lock" comment block + README section arguing the row lock is the boundary | ⬜ | `holds.queries.js`, `README.md` | Reads as a decision, not an omission | |
| P3-9 | ⭐⭐ **Concurrency proof suite** — all six scenarios from PROJECT_PROMPT §6.6, against local `ticket_booking_test` | ⬜ | `tests/setup/testDb.js`, `tests/e2e/concurrency.test.js`, `holdExpiry.test.js` | Green in CI, 3 consecutive runs | |

**Exit criteria:** 50 parallel holds on one seat → exactly one winner, every run. Seats free themselves with all workers stopped.

---

## Phase 4 — Booking, QR, email outbox

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P4-1 | Mock payment service: authorize → capture → refund | ⬜ | `modules/payments/*` | Unit test | |
| P4-2 | ⭐ `confirmBooking()`: hold→booking with the `expires_at > now()` guard; short `rowCount` ⇒ `410 HOLD_EXPIRED` | ⬜ | `bookings.service.js`, `bookings.queries.js` | Confirm at TTL+1ms fails cleanly | |
| P4-3 | Idempotency via the `bookings.idempotency_key` unique constraint — on conflict, return the original | ⬜ | `middleware/idempotency.js`, `bookings.queries.js` | 20 parallel replays → 1 booking | |
| P4-4 | Booking reference generator (Crockford base32, no ambiguous characters) | ⬜ | `utils/reference.js` | 100k generated, zero collisions | |
| P4-5 | ⭐ QR service: signed JWT (separate secret) → PNG buffer | ⬜ | `bookings/qr.service.js` | Decoded QR verifies against the secret | |
| P4-6 | ⭐ Transactional outbox: row + `OUTBOX_SEND` job both written in the booking transaction; 60s reconciler for orphaned rows | ⬜ | `queue/handlers/outboxSend.js`, `jobs/outboxReconciler.job.js` | Rolled-back booking sends no email | |
| P4-7 | Nodemailer + EJS templates; QR inline via CID; **Ethereal** auto-account in dev, preview URL logged | ⬜ | `mail/*` | Ethereal preview shows a rendering QR | |
| P4-8 | Booking history, detail, PDF ticket, cancellation (refund + seat release) | ⬜ | `bookings.*`, `ticketPdf.service.js` | E2E full lifecycle | |

**Exit criteria:** Book → email with a scannable QR lands. A rolled-back booking sends nothing.

---

## Phase 5 — Waitlist and time-limited offers ⭐

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P5-1 | Join waitlist (only when the category has zero effective availability); unique per user/show/category | ⬜ | `waitlist.service.js` | Join on an available category → 400 | |
| P5-2 | Position via `ROW_NUMBER() OVER (ORDER BY enqueued_at)`; `GET /waitlist/me` | ⬜ | `waitlist.queries.js` | Position correct after mid-queue removal | |
| P5-3 | ⭐ Cancellation routes freed seats by category: empty queue → AVAILABLE, else → `OFFER_RESERVED` | ⬜ | `bookings.service.js`, `offers.service.js` | Seat never publicly available mid-offer | |
| P5-4 | ⭐ Single-use HMAC offer token; only the hash stored; raw only in the email link | ⬜ | `offers.service.js` | Tampered and replayed tokens → 410 | |
| P5-5 | `GET /offers/:token` and `POST /accept` reusing the §6.5 guard shape | ⬜ | `waitlist.controller.js`, `offers.queries.js` | E2E accept → booking + ticket email | |
| P5-6 | ⭐ Cascade: `FOR UPDATE SKIP LOCKED` next in line, `attempt_no + 1`, `MAX_CASCADE` bound | ⬜ | `offers.service.js`, `queue/handlers/offerExpiry.js` | 3-deep cascade test; bound releases seats | |
| P5-7 | Offer reconciler cron as a safety net for lost delayed jobs | ⬜ | `jobs/offerReconciler.job.js` | Stale offer swept | |
| P5-8 | ⭐ Race test: 10 users, one offer link → 1 conversion, 9 × `410` | ⬜ | `tests/e2e/waitlist.test.js` | Green in CI | |

**Exit criteria:** Cancelling a booking gives the next person in line a working, expiring, single-use claim link that cascades correctly on lapse.

---

## Phase 6 — Realtime seat map

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P6-1 | Socket.IO server with JWT handshake auth (no adapter — single instance, documented as the scaling seam) | ⬜ | `realtime/io.js` | Two browsers, one server, both receive | |
| P6-2 | Room helpers + typed emit helpers used by every service | ⬜ | `realtime/rooms.js`, `emit.js` | No raw event strings anywhere | |
| P6-3 | Wire all seven events through `pg_notify` → listener → room. Services never emit directly | ⬜ | services + `notify/*` | Two-browser manual check; no direct `io.emit` in any service | |
| P6-4 | Presence counting, throttled 2s | ⬜ | `realtime/presence.js` | Count correct after abrupt disconnect | |
| P6-5 | Reconnect reconciliation: client hard-refetches the seat map | ⬜ | `client/src/lib/socket.js`, `hooks/useSeatMap.js` | Kill network 30s → state converges | |

**Exit criteria:** Seat changes propagate between two browsers within a second and survive a disconnect.

---

## Phase 7 — React frontend

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P7-1 | Vite + Tailwind + router shell; dark mode; base UI components | ⬜ | `client/src/main.jsx`, `App.jsx`, `components/ui/*` | Visual pass | |
| P7-2 | Auth pages + `ProtectedRoute` by role; `api/client.js` with refresh-on-401 | ⬜ | `pages/`, `router.jsx`, `api/client.js` | Redirects correct per role | |
| P7-3 | Event browse + detail + showtime picker | ⬜ | `pages/Events.jsx`, `EventDetail.jsx` | Filters work, paginated | |
| P7-4 | ⭐ Seat map component: grid, aisles, stage, zoom/pan, keyboard nav, ARIA | ⬜ | `components/seatmap/*` | Keyboard-only selection works | |
| P7-5 | ⭐ Optimistic selection + rollback on 409, conflicting seats flashed red | ⬜ | `hooks/useSeatMap.js` | Forced 409 rolls back cleanly | |
| P7-6 | ⭐ Checkout with live countdown (amber 60s, red 15s) and expiry handling | ⬜ | `pages/Checkout.jsx`, `components/HoldCountdown.jsx` | Idle to expiry → clean message | |
| P7-7 | Success screen with immediate QR; booking history; cancel dialog | ⬜ | `pages/BookingSuccess.jsx`, `Bookings.jsx` | Full flow in browser | |
| P7-8 | Sold-out → waitlist card with live position | ⬜ | `components/waitlist/*` | Position updates over socket | |
| P7-9 | ⭐ Claim page `/waitlist/claim/:token` with countdown, accept, decline | ⬜ | `pages/WaitlistClaim.jsx` | Expired token → clear message | |
| P7-10 | Skeletons, empty states, error boundaries, error-code → message mapping | ⬜ | across `components/` | No raw error strings reach users | |

**Exit criteria:** A stranger completes browse → book → ticket → cancel without guidance.

---

## Phase 8 — Reports, admin, check-in

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P8-1 | Organiser summary: revenue, tickets sold, occupancy %, waitlist depth, per category | ⬜ | `modules/reports/*` | Numbers match seeded data | |
| P8-2 | Revenue chart + CSV export | ⬜ | `components/RevenueChart.jsx` | CSV opens cleanly | |
| P8-3 | Attendee manifest per show, paginated and searchable | ⬜ | `reports.*` | E2E | |
| P8-4 | Admin venue designer: visual grid, assign categories to rows | ⬜ | `pages/admin/*` | Create a 200-seat venue in the UI | |
| P8-5 | ⭐ Check-in: `POST /tickets/verify` + camera scanner page; second scan → `ALREADY_USED` | ⬜ | `modules/tickets/*`, `pages/Scan.jsx` | Scan a real emailed QR with a phone | |

**Exit criteria:** An organiser sees money and can scan a real ticket at a real gate.

---

## Phase 9 — Hardening and proof

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P9-1 | Rate limiting (holds 10/min/user, auth 5/min/IP) | ⬜ | `middleware/rateLimit.js` | 429 returned correctly | |
| P9-2 | Audit logging on every state-changing action | ⬜ | service layer | Rows present after a full flow | |
| P9-3 | Correlation IDs in `pino`; `/health` reports pool stats, `job_queue` pending/dead, outbox backlog, listener state | ⬜ | `utils/logger.js`, `health.routes.js` | Trace one request end to end | |
| P9-4 | Graceful shutdown: drain requests, stop the poller mid-batch safely, close the `LISTEN` client and the pool | ⬜ | `server/src/index.js` | SIGTERM mid-hold → no corruption, no `RUNNING` jobs stranded | |
| P9-5 | k6 load test: 200 VUs on one show; capture the p95 chart for the README | ⬜ | `tests/load/seatRush.js` | Zero double-bookings under load | |
| P9-6 | Coverage ≥80% on `holds`, `bookings`, `waitlist` modules | ⬜ | — | Coverage report in CI | |

**Exit criteria:** The system stays correct under load, and you have a chart that proves it.

---

## Phase 10 — Docs, deploy, demo

| ID | Change | Status | Files touched | Verified by | Commit |
|---|---|---|---|---|---|
| P10-1 | ⭐ `docs/SYSTEM_DESIGN.md` — ≤800 words, leading with lazy expiry and the READ COMMITTED argument | ⬜ | `docs/SYSTEM_DESIGN.md` | Word count verified | |
| P10-2 | `README.md`: quickstart, architecture diagram, env table, mechanism explanations, **and the "Why there is no Redis" argument** | ⬜ | `README.md` | Clean machine running in under 5 min without Docker | |
| P10-3 | ⭐ `docs/SEQUENCE_DIAGRAMS.md` — Mermaid for hold→book, TTL expiry, cancel→cascade | ⬜ | `docs/` | Renders on GitHub | |
| P10-4 | `docs/API.md` + `DB_SCHEMA.md` (Mermaid ERD, index rationale) | ⬜ | `docs/` | Matches live Swagger | |
| P10-5 | ⭐ `/demo` control panel: simulate 50 concurrent holds, force-expire, trigger cascade | ⬜ | `client/src/pages/Demo.jsx` | Each button demonstrably fires | |
| P10-6 | Deploy API + managed Postgres (Render/Railway) and client (Vercel); migrate, seed, warm. No Dockerfile — platforms build from `package.json` | ⬜ | `docs/DEPLOYMENT.md` | Public URL works from a cold phone | |
| P10-7 | `DEMO.md` grader script + credentials; source zip (no `node_modules`, no `.env`) | ⬜ | `DEMO.md` | Zip extracts and runs clean | |

**Exit criteria:** Someone who has never seen the project goes from a link to impressed in five minutes.

---

## Decisions Ledger

Record every non-obvious choice here as it is made. This is the artefact that shows judgement.

| # | Date | Decision | Alternatives considered | Rationale |
|---|---|---|---|---|
| D-1 | — | Raw SQL with `pg`, no ORM | Prisma, Sequelize, Knex | The atomic acquire must be hand-written SQL regardless. An ORM would hide the one query that matters and add a layer to explain in review. |
| D-2 | — | Lazy expiry: `expires_at` in the SQL predicate is authoritative | Cron-only release; TTL held only in a cache | Correctness must not depend on a worker running. Schedulers materialise and broadcast; they don't decide. **READ COMMITTED verification (for P10-1):** confirmed against Postgres semantics — under READ COMMITTED, a statement that blocks on a row lock re-evaluates its WHERE clause against the latest *committed* row version once the lock is released (the EvalPlanQual mechanism), so the loser of a race simply fails to match; no retry loop, no `SERIALIZABLE`, no lost update. In `holds.queries.js` specifically, the `FOR UPDATE` CTE locks unconditionally on `show_id`/`seat_id`, and the state predicate lives in the outer `UPDATE`, so by the time it evaluates it is always reading post-lock-wait, current data — the CTE's data-modifying nature guarantees it runs to completion (all waiting included) before the outer statement consumes it. One residual nuance: `ORDER BY seat_id` in the CTE prevents acquire-vs-acquire deadlocks (D-4), but the Layer-3 reconciler's bulk sweep has no such ordering, so an acquire's expired-hold reclaim can, rarely, deadlock against a concurrent reconciler pass — Postgres detects it and aborts one side (`40P01`). Not a correctness gap (the reconciler is idempotent and re-runs in 30s regardless), but `holds.service.js` should catch `40P01` and retry its transaction once rather than surfacing it as a `409`. |
| D-3 | — | READ COMMITTED + `FOR UPDATE` CTE instead of SERIALIZABLE | SERIALIZABLE with retry loop; optimistic version column | Postgres re-evaluates the `WHERE` clause after a lock wait, so the loser simply doesn't match. No retries, no serialization failures. |
| D-4 | — | Lock ordering by `seat_id` | Unordered `ANY($2)` | Two overlapping multi-seat requests take locks in the same order, so they queue rather than deadlock. |
| D-5 | — | Every query function takes an explicit `client` | Module-level `pool.query` | With `pg`, calling `pool.query` inside a transaction gets a *different* connection and silently escapes it. Passing the client makes that impossible. |
| D-6 | — | **No Redis at all.** Postgres is the only datastore | Redis for locks, delayed jobs, keyspace TTL, queue position | Every job Redis would do has a Postgres primitive that is *transactionally consistent with the booking data itself*. One datastore = one source of truth, one transaction boundary, no cross-system consistency problem. The scaling threshold where Redis becomes right is a second API instance — say so rather than pretending it never applies. |
| D-6a | — | No application-level lock on seat selection | Redlock; advisory locks | The `FOR UPDATE` row lock is already the correctness boundary. A lock elsewhere could only agree with it or be wrong, and adds a failure mode. |
| D-6b | — | `job_queue` table + `FOR UPDATE SKIP LOCKED` instead of BullMQ | BullMQ; `pg_cron`; setTimeout | Same claim-exactly-once semantics, ~80 lines, and it reuses the identical primitive as the waitlist cascade — one pattern to learn and defend instead of two. Jobs enqueue *inside* the caller's transaction, so a hold cannot exist without its expiry job. |
| D-6c | — | `pg_notify` inside the transaction instead of emitting from services | Direct `io.emit` after commit; Redis pub/sub | NOTIFY only delivers if the transaction commits, so a broadcast can never announce a seat release that then rolls back. Strictly stronger than the Redis version. |
| D-7 | — | Cancelled seats go to `OFFER_RESERVED`, never back to the public pool | Release then re-check | Otherwise a random browser snipes the seat the waitlist was promised. |
| D-8 | — | Transactional outbox for all email | Fire-and-forget after commit | Prevents emails for rolled-back bookings and lost emails on crash. |
| D-9 | — | `MAX_CASCADE_ATTEMPTS = 5` | Unbounded cascade | Bounds how long a seat sits locked behind an inactive queue. |
| D-10 | — | QR signed with a secret distinct from auth | Reuse `JWT_ACCESS_SECRET` | Blast-radius isolation; a leaked ticket key can't mint sessions. |
| D-11 | — | Real local `ticket_booking_test` database over mocks for concurrency tests | `vi.mock` on the pool; testcontainers | A mocked database has no row locks, so a mocked concurrency test proves nothing. Containers were unavailable on the dev machine, so tests use the real Postgres already installed — same guarantee, no dependency. |
| D-12 | — | JSDoc + `checkJs` instead of TypeScript | Full TS | Keeps the stack familiar while still catching shape errors in the editor, and doubles as the documentation the reviewer wants. |
| D-13 | 2026-08-23 | Fixed `.gitignore`, which listed `CLAUDE.md`/`BUILD_LOG.md`/`FILE_MANIFEST.md`/`PROJECT_PROMPT.md` by bare filename and so was silently excluding the spec docs (including their `docs/` copies) from every commit; relocated `FILE_MANIFEST.md` from repo root to `docs/FILE_MANIFEST.md` to match where CLAUDE.md and the manifest itself say it lives | Leave as found | Both working rule #3 ("BUILD_LOG.md and FILE_MANIFEST.md updates go in the same commit as the code") and every task's Definition of Done depend on these files actually being tracked. Caught before it silently broke every future task close-out. |
| D-14 | 2026-08-23 | Two timestamps on `show_seats` for `OFFER_RESERVED`: `expires_at` (the current cascade attempt's deadline, extended on each cascade) and `reserved_until` (the fixed end of the whole cascade window, set once on entry, never extended). `reserved_until = now() + (offer_ttl_seconds × WAITLIST_MAX_CASCADE_ATTEMPTS) + 60s grace`. Acquire predicate for `OFFER_RESERVED` now checks `reserved_until <= now()`, not `expires_at` | A single `expires_at` reused for both `HELD` and `OFFER_RESERVED` — the original §6.1 predicate, which let a public hold reclaim a seat mid-cascade the instant one attempt's `expires_at` lapsed, contradicting §7.2/D-7 | Resolves the contradiction flagged when critiquing the spec before P0-1. Attempt N of a cascade ends by `N × offer_ttl_seconds`, so `MAX_CASCADE × offer_ttl_seconds` is a hard upper bound on how long any *legitimate* cascade can run. Past `reserved_until`, no legitimate cascade can still be in flight, so the seat is definitively public — a public hold can acquire it. Before `reserved_until`, it can't, no matter how stale the current `expires_at` looks, so offer exclusivity (D-7) holds even mid-cascade. Lazy expiry (D-2) still backstops `reserved_until` itself — no worker needs to run for the seat to become correctly acquirable once it passes. |

---

## Risk register

| Risk | Impact | Mitigation | Owner task |
|---|---|---|---|
| `pool.query` used inside a transaction, silently escaping it | **Critical** — breaks every correctness guarantee | Every query function takes `client`; lint rule or review check; commented at the top of each `*.queries.js` | P1-3 |
| Client not released on an error path, exhausting the pool | High — total outage under load | `client.release()` in `finally`, always; k6 test watches pool metrics | P1-3, P9-5 |
| Free-tier host sleeps; first grader request times out | High — bad first impression | Uptime pinger + `DEMO.md` warns about a 30s cold start | P10-6 |
| SMTP provider blocks unverified recipients | High — no ticket email | Ethereal in dev (no restrictions, preview URLs); verify a sending domain early for prod; document the sandbox limit | P4-7 |
| `LISTEN` connection drops silently; realtime dies with no error | Medium — UI goes stale, looks broken in the demo | Listener reconnects with backoff; `/health` reports listener state; layers 1 and 3 keep correctness regardless | P3-6 |
| Job poller crashes or is stopped; holds never materialise | Medium | The 30s cron reconciler is independent of the poller and sweeps regardless — this is why layer 3 exists | P3-7 |
| 4 GB RAM: dev server + Vite + tests + browser at once | High — thrashing, confusing failures | Separate `dev:server` / `dev:client` scripts; `docs/TESTING.md` says stop the server before running tests; pool max 10 | P0-3, P9-6 |
| Reviewer reads "no Redis" as a gap rather than a decision | Medium — undersells the work | Dedicated README section arguing it, plus the scaling threshold where Redis *would* be right | P3-8, P10-2 |
| Seat map render lag on 500+ seats | Medium | Memoise `Seat`, batch socket patches, virtualise rows | P7-4 |
| Clock skew between instances affects TTL | Low | Use `now()` from Postgres in every predicate, never the app clock | P3-2 |
| Concurrency tests flaky in CI | Medium — undermines the headline claim | Run 3× in CI; assert exact counts, never "at least" | P3-9 |

---

## Changelog

Append on every merge to `main`. Keep-a-Changelog format, Conventional Commits.

```
## [Unreleased]
### Added
### Changed
### Fixed
```

**Example entry, for format:**

```
## [0.3.0] — 2026-XX-XX
### Added
- feat(holds): atomic seat acquire via FOR UPDATE CTE with deterministic ordering [P3-2]
- feat(holds): three-layer TTL — SQL predicate, in-transaction job row, cron reconciler [P3-5..P3-7]
- test(concurrency): 50-parallel-hold suite on local test DB; asserts exactly one winner [P3-9]
### Changed
- refactor(seatmap): all state transitions routed through seatState.machine.js [P3-1]
### Fixed
- fix(holds): releaseHold() is now idempotent; concurrent releases no longer throw [P3-4]
```

---

## Session log

| Date | Tasks worked | Commits pushed | Outcome | Next up |
|---|---|---|---|---|
| 2026-08-23 | P0-1 | 1 (see commit hash reported in chat) | npm workspaces (`server`/`client`/`shared`) live, ESM throughout, `npm install` clean. Also fixed `.gitignore` accidentally excluding spec docs, and relocated `FILE_MANIFEST.md` into `docs/` to match spec references | P0-2 |

---

## Git checkpoints

Tag every phase completion so a reviewer can inspect clean states.

| Phase | Branch | Merged to `main` | Tag | Notes |
|---|---|---|---|---|
| 0 | `phase/0-foundation` | ⬜ | `v0.1.0-phase0` | branch created, P0-1 in progress on it |
| 1 | `phase/1-db-auth` | ⬜ | `v0.2.0-phase1` | |
| 2 | `phase/2-venues-shows` | ⬜ | `v0.2.5-phase2` | |
| 3 | `phase/3-holds-concurrency` | ⬜ | `v0.3.0-phase3` | ⭐ scored |
| 4 | `phase/4-booking-qr` | ⬜ | `v0.4.0-phase4` | |
| 5 | `phase/5-waitlist` | ⬜ | `v0.5.0-phase5` | ⭐ scored |
| 6 | `phase/6-realtime` | ⬜ | `v0.6.0-phase6` | |
| 7 | `phase/7-frontend` | ⬜ | `v0.7.0-phase7` | |
| 8 | `phase/8-reports-checkin` | ⬜ | `v0.8.0-phase8` | |
| 9 | `phase/9-hardening` | ⬜ | `v0.9.0-phase9` | |
| 10 | `phase/10-docs-deploy` | ⬜ | `v1.0.0` | ship |

**Push rules:** push after every completed task, and at the halfway point of any task running past ~40 minutes. Never push a red build under a `feat:` message — use `wip:`. A failed push is reported immediately, never worked around.