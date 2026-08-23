# Ticket Booking System — File Manifest

> Every file in the repository, what it does, and why it exists. **Update this in the same commit that adds, removes, or repurposes a file.**
>
> Legend — **⭐ Critical**: contains scored logic, review before touching. **🔒 Locked**: change only with a Decisions Ledger entry in `BUILD_LOG.md`.

**Stack:** Node 20 + Express 5 + PostgreSQL (`pg`, raw SQL) · React 18 + Vite · plain JavaScript, ESM throughout.

**No Docker. No Redis. No containers.** PostgreSQL is the only service to install. Development machine is Windows, 4 GB RAM.

---

## Root

| File | Purpose |
|---|---|
| `README.md` | Front door. Quickstart, architecture diagram, env table, prose on hold TTL / concurrency / waitlist. Graders read this first — it must stand alone. |
| `DEMO.md` | Grader walkthrough: credentials, 5-minute script, what to click to see each mechanism fire. |
| `.gitattributes` | Forces LF line endings on `.sh` and `.sql`. Windows CRLF silently breaks both. |
| `.env.example` | 🔒 Every variable, commented with what it controls and what breaks if it's wrong. Must match `server/src/config/env.js`. |
| `package.json` | npm workspaces root (`server`, `client`, `shared`). Scripts: `dev`, `lint`, `test`, `test:concurrency`, `db:migrate`, `db:seed`. |
| `jsconfig.json` | `checkJs: true` — gives editor type-checking from JSDoc without a build step. |
| `.eslintrc.json` | ESLint flat config, `eslint-plugin-jsdoc` on so missing docblocks are lint errors. |
| `.gitignore` | Excludes `node_modules`, `.env`, `dist`, coverage. |
| `docs/` | See bottom of this file. |

---

## `.github/workflows/`

| File | Purpose |
|---|---|
| `ci.yml` | On push/PR: install → lint → unit → e2e against GitHub's Postgres **service container**. (CI runs on GitHub's Linux runners, so containers are fine there — they never run on the dev machine.) **The concurrency suite runs here** — visible green CI is part of the pitch. |

---

## `shared/` — imported by both server and client

Plain ESM modules. The point is that a contract exists in exactly one place.

| File | Purpose |
|---|---|
| `package.json` | Workspace manifest. `name: "shared"`, `type: module`. No dependencies of its own — it's imported by path from `server`/`client`, not installed as a package. |
| `errors.js` | 🔒 Canonical error-code constants with a comment on each: when it's thrown and what the UI should do. Server throws these; client switches on them. |
| `seatStates.js` | 🔒⭐ The `SEAT_STATES` constants **and** the legal-transition map. Imported by the server's state-machine guard and the client's colour mapper — one definition, zero drift. |
| `socketEvents.js` | ⭐ Socket.IO event-name constants. Never a raw string in either codebase. |
| `schemas/auth.schema.js` | Zod: register, login. |
| `schemas/venue.schema.js` | Venue, category, bulk seat creation, `layoutMeta` shape. |
| `schemas/event.schema.js` | Event + show creation, price maps, browse filters. |
| `schemas/hold.schema.js` | ⭐ Hold request/response including `expiresAt` — drives the client countdown. |
| `schemas/booking.schema.js` | Confirm, history, cancellation. |
| `schemas/waitlist.schema.js` | ⭐ Join, position, offer detail, accept/decline. |
| `index.js` | Barrel export. |

---

## `server/` — Express API

### Bootstrap and configuration

| File | Purpose |
|---|---|
| `package.json` | Workspace manifest. `name: "server"`, `type: module`. Real dependencies (Express, `pg`, etc.) land in P0-4 onward, one task at a time. |
| `src/index.js` | Entry point. Starts the HTTP server, attaches Socket.IO, starts the job poller and cron reconcilers, opens the `LISTEN` connection, registers graceful-shutdown handlers (in-flight holds must not be orphaned on deploy). |
| `src/app.js` | Builds the Express app: helmet, CORS with credentials, cookie-parser, `pino-http`, routers, Swagger, error handler last. Exported separately from `index.js` so Supertest can mount it without opening a port. |
| `src/config/env.js` | 🔒 Zod-validated environment. Throws at boot on anything missing. Mirrors `.env.example` exactly. |
| `src/config/swagger.js` | `swagger-jsdoc` setup; scans route files for JSDoc and serves `/api/docs`. |

### Database layer

| File | Purpose |
|---|---|
| `src/db/pool.js` | ⭐ The single `pg.Pool`. Configured max connections, idle timeout, and an `error` handler so a dropped backend doesn't crash the process. |
| `src/db/withTransaction.js` | 🔒⭐ `BEGIN`/`COMMIT`/`ROLLBACK` wrapper with `SET LOCAL statement_timeout` and a guaranteed `client.release()` in `finally`. **Every query function takes a `client`** — calling `pool.query` inside a transaction silently escapes it, which is the easiest way to break correctness with `pg`. Documented at the top of the file. |
| `src/db/migrations/001_init.sql` | Enums, users, venues, seat categories, seats. |
| `src/db/migrations/002_events_shows.sql` | Events, shows, show prices. |
| `src/db/migrations/003_show_seats.sql` | ⭐ `show_seats`, `seat_holds`, and the indexes that make the sweep and availability queries fast. Header comment explains `UNIQUE (show_id, seat_id)`. |
| `src/db/migrations/004_bookings.sql` | Bookings, booking seats, payments. |
| `src/db/migrations/005_waitlist.sql` | ⭐ Waitlist entries, offers, and the FIFO index. |
| `src/db/migrations/006_outbox_audit.sql` | Outbox events, ticket scans, audit log. |
| `src/db/seed.js` | Demo data: 3 venues, 8 events, 20 shows, **one deliberately sold-out show** with a pre-populated waitlist, plus admin/organiser/customer accounts. Idempotent. Makes the demo instant. |

### Infrastructure

| File | Purpose |
|---|---|
| `src/notify/publisher.js` | ⭐ `pgNotify(client, channel, payload)` — called **inside** the caller's transaction, so a notification can only fire if the transaction commits. Services never emit to Socket.IO directly; they go through here. |
| `src/notify/listener.js` | ⭐ One long-lived `pg.Client` (not from the pool — a `LISTEN` connection is occupied) holding `LISTEN seat_changes`. Forwards payloads to the right Socket.IO room. Reconnects with backoff if the connection drops. |
| `src/queue/enqueue.js` | ⭐ `enqueueJob(client, type, payload, runAt)` — inserts into `job_queue` **inside the caller's transaction**, so a hold can never exist without its expiry job. |
| `src/queue/poller.js` | ⭐ Runs every 2s. Claims a batch with `FOR UPDATE SKIP LOCKED`, dispatches by type, marks DONE, or reschedules with exponential backoff. DEAD after `JOB_MAX_ATTEMPTS`. This is the BullMQ replacement — ~80 lines, and the most reusable thing in the repo. |
| `src/queue/handlers/holdExpiry.js` | ⭐ Job type `HOLD_EXPIRY` → idempotent release. **Layer 2** of the TTL design. |
| `src/queue/handlers/offerExpiry.js` | ⭐ Job type `OFFER_EXPIRY` → cascade to the next entry in the queue. |
| `src/queue/handlers/outboxSend.js` | ⭐ Job type `OUTBOX_SEND` → renders and sends the email, marks the outbox row SENT/FAILED. |
| `src/jobs/holdReconciler.job.js` | ⭐ `node-cron` every 30s sweeping `state='HELD' AND expires_at <= now()`. **Layer 3** — the safety net under the safety net. Runs whether or not the poller is alive. |
| `src/jobs/offerReconciler.job.js` | Same for lapsed offers whose job row was lost. |
| `src/mail/mailer.js` | Nodemailer transport. In dev, auto-creates an **Ethereal** test account and logs the preview URL — no mail server to install. In prod, SMTP from env. Renders EJS → HTML, attaches the QR PNG via CID. |
| `src/mail/templates/bookingConfirmed.ejs` | Ticket email: event details, seats, total, embedded QR. |
| `src/mail/templates/waitlistOffer.ejs` | ⭐ Offer email: seats reserved, deadline, large Claim button. |
| `src/db/migrations/007_job_queue.sql` | ⭐ The `job_queue` table and its partial claim index. Header comment explains the `SKIP LOCKED` pattern. |
| `src/mail/templates/bookingCancelled.ejs` | Cancellation + refund summary. |
| `src/mail/templates/offerExpired.ejs` | Courtesy notice that the window lapsed. |

### Middleware

| File | Purpose |
|---|---|
| `src/middleware/requireAuth.js` | Verifies the access token from the httpOnly cookie, attaches `req.user`. |
| `src/middleware/requireRole.js` | ⭐ RBAC. `requireRole('ADMIN')`. |
| `src/middleware/requireOwnership.js` | ⭐ Separate from RBAC: an organiser has the role *and* must own the event. Commonly missed — has its own test. |
| `src/middleware/validate.js` | Runs a Zod schema against `body`/`query`/`params`, returns 422 with field details. |
| `src/middleware/idempotency.js` | ⭐ Replay protection via the `bookings.idempotency_key` unique column: on a duplicate-key violation, load and return the original booking instead of erroring. No cache layer needed — the constraint *is* the mechanism. |
| `src/middleware/errorHandler.js` | 🔒 Last in the chain. Maps domain errors to HTTP status + stable codes; unknown errors become a 500 with a logged correlation id and no stack leak. |
| `src/middleware/rateLimit.js` | `express-rate-limit` configs: holds 10/min/user, auth 5/min/IP. |

### Modules

Each module is four files: `*.routes.js` (router + validation + Swagger JSDoc) → `*.controller.js` (req/res only) → `*.service.js` (business logic, transactions) → `*.queries.js` (raw SQL, takes a `client`). Keeping SQL in its own file is what makes the concurrency work reviewable.

| Module | Files | Notes |
|---|---|---|
| **auth** | `auth.routes.js`, `auth.controller.js`, `auth.service.js`, `auth.queries.js` | argon2 hashing, token issue and rotation, refresh reuse detection. |
| **venues** | 4 files | Admin CRUD, categories, bulk seat creation. Layout validation: no duplicate grid coordinates, every seat categorised. |
| **events** | 4 files | Organiser CRUD + public browse with filters and pagination. |
| **shows** | 4 files | ⭐ `publishShow()` materialises one `show_seats` row per venue seat in a single batched insert. The moment the seat map comes into existence. |
| **seatmap** | `seatmap.routes.js`, `seatmap.controller.js`, `seatmap.service.js`, `seatmap.queries.js` | ⭐ Computes **effective** state — an expired `HELD` renders as available regardless of the stored value. **Layer 1** of the TTL design. |
| | `seatState.machine.js` | 🔒⭐ `assertTransition()` over the map in `shared/seatStates.js`. Every state change routes through it. ~40 lines that prove the model is sound. |
| **holds** | `holds.routes.js`, `holds.controller.js` | POST / GET / DELETE. |
| | `holds.service.js` | 🔒⭐ Orchestration: acquire, idempotent `releaseHold()`, TTL registration across all three layers, socket broadcast. Carries a numbered walkthrough comment. |
| | `holds.queries.js` | 🔒⭐ **The most important file in the repo.** The `FOR UPDATE` CTE with deterministic `ORDER BY seat_id`. Heavily commented: why one statement, why this predicate, why this ordering, what the loser of a race experiences. |
| **bookings** | `bookings.routes.js`, `bookings.controller.js` | confirm / list / detail / cancel / ticket. |
| | `bookings.service.js` | ⭐ Hold→booking conversion with the `expires_at > now()` guard; cancellation orchestration; writes the outbox row **inside the same transaction**. |
| | `bookings.queries.js` | ⭐ The conversion UPDATE and cancellation SQL. |
| | `qr.service.js` | ⭐ Signs the QR JWT with a separate secret, renders the PNG buffer. |
| | `ticketPdf.service.js` | Renders a downloadable PDF ticket (`pdfkit`). |
| **waitlist** | `waitlist.routes.js`, `waitlist.controller.js` | Join, position, leave. |
| | `waitlist.service.js` | ⭐ FIFO queue operations and position lookup via `ROW_NUMBER() OVER (ORDER BY enqueued_at)` — position and source of truth come from one query, so they cannot disagree. |
| | `waitlist.queries.js` | ⭐ Includes the `FOR UPDATE SKIP LOCKED` head-of-queue select. |
| | `offers.service.js` | 🔒⭐ Offer creation, HMAC token issue, single-use validation, cascade with the `MAX_CASCADE` bound. |
| | `offers.queries.js` | ⭐ Offer lifecycle SQL. |
| **tickets** | `tickets.routes.js`, `tickets.controller.js`, `tickets.service.js` | ⭐ Signature check → single-use check-in → `ticket_scans` audit row. |
| **payments** | `payments.service.js` | Mock gateway: authorize / capture / refund. Isolated so a real PSP drops in. |
| **reports** | 4 files | Organiser revenue, occupancy, waitlist depth, CSV export. |
| **health** | `health.routes.js` | DB connectivity, pool stats, `job_queue` pending/dead counts, outbox backlog, listener connected. Used by the platform health check. |

### Realtime

| File | Purpose |
|---|---|
| `src/realtime/io.js` | ⭐ Socket.IO server with JWT handshake auth. No adapter — single instance. Comment names this as the exact point where a shared adapter would be needed to scale horizontally. |
| `src/realtime/rooms.js` | Room naming (`show:{id}`, `user:{id}`) in one place. |
| `src/realtime/emit.js` | Emit helpers called by `notify/listener.js`, never by services directly. Services notify the database; the database drives the socket. |
| `src/realtime/presence.js` | Viewer counting per show room, throttled to 2s. |

### Utilities

| File | Purpose |
|---|---|
| `src/utils/reference.js` | Booking reference generator (`TB-` + Crockford base32, no ambiguous characters). |
| `src/utils/errors.js` | Domain error classes: `SeatsUnavailableError`, `HoldExpiredError`, `OfferInvalidError`, `IllegalSeatTransitionError`. Each carries its code from `shared/errors.js`. |
| `src/utils/logger.js` | `pino` instance with correlation-id support. |
| `src/utils/asyncRoute.js` | Only needed if you end up on Express 4 — Express 5 forwards async rejections natively. |
| `src/utils/backoff.js` | Exponential backoff with jitter, shared by the job poller and the outbox handler. |

### Tests

| File | Purpose |
|---|---|
| `tests/setup/testDb.js` | Connects to the local `ticket_booking_test` database, runs migrations once, truncates all tables between tests. Real Postgres, no containers — mocks have no row locks and cannot test races. |
| `tests/unit/seatState.machine.test.js` | Full legal/illegal transition matrix. |
| `tests/unit/offerToken.test.js` | Token generation, hashing, tamper and replay rejection. |
| `tests/unit/reference.test.js` | 100k references, zero collisions, no ambiguous characters. |
| `tests/e2e/auth.test.js` | Registration, login, refresh rotation, RBAC and ownership denials. |
| `tests/e2e/bookingFlow.test.js` | Browse → hold → confirm → outbox row → QR present. |
| `tests/e2e/holdExpiry.test.js` | ⭐ TTL release; **and the same assertion with workers stopped**, proving lazy expiry. |
| `tests/e2e/concurrency.test.js` | ⭐⭐ The headline suite: 50 parallel holds → 1 winner; 20 parallel confirms → 1 booking; overlapping sets → all-or-nothing. |
| `tests/e2e/waitlist.test.js` | ⭐ Cancel → offer → accept; expiry → cascade; 10 users racing one link → 1 winner. |
| `tests/e2e/ticketVerify.test.js` | Second scan returns `ALREADY_USED`. |
| `tests/load/seatRush.js` | k6 script, 200 VUs on one show. Optional; the p95 chart is a nice README asset. |

---

## `client/` — React + Vite

### Entry and routing

| File | Purpose |
|---|---|
| `package.json` | Workspace manifest. `name: "client"`, `type: module`. Vite/React/Tailwind land in P7-1. |
| `index.html` | Vite entry. |
| `vite.config.js` | Dev proxy to the API so cookies work same-origin in development. |
| `src/main.jsx` | Mounts React, wraps in QueryClientProvider, router, error boundary, toaster. |
| `src/App.jsx` | Layout shell: nav, auth state, dark-mode toggle. |
| `src/router.jsx` | All routes; `ProtectedRoute` wrapper enforcing role. |

### Pages

| File | Purpose |
|---|---|
| `src/pages/Home.jsx` | Landing + featured events. |
| `src/pages/Events.jsx` | Browse with filters (type, city, date, search) and pagination. |
| `src/pages/EventDetail.jsx` | Event detail + showtime picker. |
| `src/pages/ShowSeatMap.jsx` | ⭐ The seat map screen. The heart of the UX. |
| `src/pages/Checkout.jsx` | ⭐ Checkout with the live hold countdown. |
| `src/pages/BookingSuccess.jsx` | QR shown immediately, before the email arrives. |
| `src/pages/Bookings.jsx` / `BookingDetail.jsx` | History, QR, download, cancel. |
| `src/pages/WaitlistClaim.jsx` | ⭐ Public offer claim screen with countdown, accept, decline. |
| `src/pages/organiser/*.jsx` | Dashboard, event/show creation, revenue reports, attendee manifest. |
| `src/pages/admin/*.jsx` | Venue list, seat-layout designer, category management. |
| `src/pages/Scan.jsx` | Camera QR scanner for gate check-in. |
| `src/pages/Demo.jsx` | ⭐ Grader control panel — trigger each mechanism on demand. |

### Components

| File | Purpose |
|---|---|
| `src/components/seatmap/SeatMap.jsx` | ⭐ Grid renderer with aisles, stage marker, zoom/pan, keyboard nav. |
| `src/components/seatmap/Seat.jsx` | ⭐ One seat: colour by effective state, hatched when held by another, pulsing outline when yours. |
| `src/components/seatmap/SeatLegend.jsx` | Category colours, prices, state key. |
| `src/components/seatmap/SelectionSummary.jsx` | Sticky bar: seats, total, Continue. |
| `src/components/seatmap/PresenceIndicator.jsx` | "4 people viewing this show." |
| `src/components/HoldCountdown.jsx` | ⭐ `mm:ss` from `expiresAt`, amber at 60s, red at 15s, fires the expiry handler at zero. |
| `src/components/waitlist/WaitlistCard.jsx` | Join CTA + live position for a sold-out category. |
| `src/components/waitlist/OfferCountdown.jsx` | Large countdown on the claim page. |
| `src/components/QRTicket.jsx` | QR + booking reference. |
| `src/components/CancelDialog.jsx` | Confirms cancellation, warns the seat goes to the waitlist. |
| `src/components/RevenueChart.jsx` | Recharts revenue-by-category. |
| `src/components/ui/*.jsx` | Button, Input, Dialog, Badge, Skeleton, Toast — hand-rolled on Tailwind + Headless UI. |

### Client infrastructure

| File | Purpose |
|---|---|
| `src/api/client.js` | `fetch` wrapper: credentials, refresh-on-401 retry, maps `error.code` to friendly messages via `shared/errors.js`. |
| `src/api/*.js` | One file per domain (`holds.js`, `bookings.js`, `waitlist.js`) — thin functions returning parsed data. |
| `src/lib/socket.js` | ⭐ Socket.IO client using `shared/socketEvents.js`; auto-rejoins the room and **hard-refetches the seat map on reconnect**. |
| `src/hooks/useSeatMap.js` | ⭐ TanStack Query + socket patches. Optimistic selection, server reconciliation, rollback on 409. |
| `src/hooks/useHold.js` | Create/release hold, countdown state, `sendBeacon` on unload. |
| `src/hooks/useWaitlistPosition.js` | Live position over the socket. |
| `src/hooks/useAuth.js` | Session state, login/logout, role helpers. |
| `src/store/selectionStore.js` | Zustand: selected seats, max-selection rule. |
| `src/lib/seatColors.js` | Maps state → Tailwind classes using `shared/seatStates.js`. Colour logic in exactly one place. |

---

## `docs/`

| File | Purpose |
|---|---|
| `PROJECT_PROMPT.md` | The master build brief. Spec of record. |
| `FILE_MANIFEST.md` | This file. |
| `BUILD_LOG.md` | Task ledger, decisions ledger, git checkpoints, changelog. |
| `SYSTEM_DESIGN.md` | ⭐ The ≤800-word write-up. A graded deliverable — treat it as a product, not a byproduct. |
| `API.md` | Endpoint reference with examples and every error code. |
| `DB_SCHEMA.md` | Mermaid ERD + rationale for each index, especially `UNIQUE (show_id, seat_id)`. |
| `SEQUENCE_DIAGRAMS.md` | ⭐ Mermaid: hold→book, TTL expiry across three layers, cancel→offer→cascade. Diagrams are what people remember. |
| `ARCHITECTURE.md` | Component diagram, request lifecycle, scaling notes. |
| `TESTING.md` | How to create `ticket_booking_test`, run the concurrency suite, and read its output. **Notes that the dev server must be stopped first** — 4 GB does not stretch to both. |
| `DEPLOYMENT.md` | Render/Railway (API + managed Postgres) and Vercel/Netlify (client). One database, no Redis add-on, no Dockerfile needed — the platforms detect Node and build from `package.json`. |

---

## Sanity checks

Roughly 140–160 files. If a module needs more than its four standard files plus one, it's doing too much.

**The one rule that matters:** `holds.queries.js` keeps the atomic acquire as **one SQL statement**. If it grows, extract *around* it — never split it. Splitting it into read-then-write is the exact bug this entire design exists to prevent.