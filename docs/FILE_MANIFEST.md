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
| `eslint.config.js` | ESLint flat config (ESLint 9+ default; not `.eslintrc.json` — that filename is the legacy format and wouldn't apply under a flat-config ESLint version). `eslint-plugin-jsdoc` on for `server/src/**` and `shared/**` so missing docblocks on exported functions are lint warnings; `eslint-config-prettier` last in the array so style rules never fight Prettier. |
| `.prettierrc.json` | Prettier formatting rules (single quotes, semicolons, 100-col, LF). |
| `.prettierignore` | Excludes `docs/` and other `.md` — hand-formatted tables and prose shouldn't get reflowed. |
| `.gitignore` | Excludes `node_modules`, `.env`, `dist`, coverage. |
| `docs/` | See bottom of this file. |

---

## `.github/workflows/`

| File | Purpose |
|---|---|
| `ci.yml` | On push/PR: install → lint → unit → e2e against GitHub's Postgres **service container**. (CI runs on GitHub's Linux runners, so containers are fine there — they never run on the dev machine.) **The concurrency suite runs here** — visible green CI is part of the pitch. As of P0-7: the Postgres service and `DATABASE_URL`/JWT secrets are live (plain fake values inline, not GitHub Secrets — see D-20, a fork or clone must go green without needing repo-secret setup), but `npm test --if-present` has nothing to run until Phase 1+ adds a test script and real tests. |

---

## `shared/` — imported by both server and client

Plain ESM modules. The point is that a contract exists in exactly one place.

| File | Purpose |
|---|---|
| `package.json` | Workspace manifest. `name: "shared"`, `type: module`. No dependencies of its own — it's imported by path from `server`/`client`, not installed as a package. |
| `errors.js` | 🔒 Canonical error-code constants with a comment on each: when it's thrown and what the UI should do. Server throws these; client switches on them. Created at P0-4 with only the two generic codes (`INTERNAL_ERROR`, `NOT_FOUND`) a bare Express skeleton needs — domain-specific codes (`SEATS_UNAVAILABLE`, `HOLD_EXPIRED`, ...) are added by the phase that introduces the mechanism they describe. P1-5 added the 5 auth codes §9's own example list doesn't mention (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `REFRESH_INVALID`) — §9's list was never meant to be exhaustive, just illustrative of the seat/booking mechanisms it documents. P2-1 added `CONFLICT`, deliberately generic across every Phase 2 unique-constraint violation rather than one code per resource — see "Phase 2 debt" in `docs/BUILD_LOG.md`. P3-1 added `ILLEGAL_SEAT_TRANSITION`, the first of §9's named Phase-3 codes to land. P3-3 added `SEATS_UNAVAILABLE`. |
| `seatStates.js` | 🔒⭐ Built at P3-1. The `SEAT_STATES` constants **and** the legal-transition map (`SEAT_TRANSITIONS`). Imported by the server's state-machine guard and the client's colour mapper — one definition, zero drift. Deep-frozen (the outer map AND every per-state array individually — `Object.freeze()` alone is shallow) since this file is loaded into two separate runtimes. |
| `socketEvents.js` | ⭐ Socket.IO event-name constants. Never a raw string in either codebase. |
| `schemas/auth.schema.js` | Zod: register, login. Registration accepts `role` only as ORGANISER/CUSTOMER at the schema level — `auth.service.js` is what actually refuses to ever grant ADMIN publicly (D-28). |
| `schemas/venue.schema.js` | Built at P2-1. Venue (with an optional, defaulted `layoutMeta`), category, and bulk-seat-creation shapes. Bulk seat rows expand server-side (`venues.service.js`) — the request body stays proportional to the venue's row count, not its seat count. |
| `schemas/event.schema.js` | Built at P2-4/P2-5. Event creation, browse-filter query shape, and show creation with per-category `prices[]`. `updateEventSchema` is deliberately hand-written rather than `createEventSchema.partial()` — see D-32; `.partial()` alone doesn't stop a field's `.default()` from filling in an omitted PATCH key. |
| `schemas/hold.schema.js` | ⭐ Built at P3-3. `createHoldSchema`: `{ showId, seatIds[] }`. Deliberately does NOT enforce `MAX_SEATS_PER_BOOKING` — that's server-only env, enforced in `holds.service.js#createHold` instead (see that file's header). |
| `schemas/booking.schema.js` | Confirm, history, cancellation. |
| `schemas/waitlist.schema.js` | ⭐ Join, position, offer detail, accept/decline. |
| `index.js` | Barrel export. |

---

## `server/` — Express API

### Bootstrap and configuration

| File | Purpose |
|---|---|
| `package.json` | Workspace manifest. `name: "server"`, `type: module`. Real dependencies (Express, `pg`, etc.) land in P0-4 onward, one task at a time. |
| `src/index.js` | Entry point. Starts the HTTP server, attaches Socket.IO, starts the job poller and cron reconcilers, opens the `LISTEN` connection, registers graceful-shutdown handlers (in-flight holds must not be orphaned on deploy). As of P0-4: just `app.listen()` — Socket.IO (P6-1), the poller (P1-4), `LISTEN` (P3-6) and graceful shutdown (P9-4) are added as each subsystem they'd operate on is built. |
| `src/app.js` | Builds the Express app: helmet, CORS with credentials, cookie-parser, `pino-http`, routers, Swagger, error handler last. Exported separately from `index.js` so Supertest can mount it without opening a port. Swagger and the full route set land as their owning modules are built; P0-4 wires the skeleton (helmet/CORS/cookies/JSON body/pino-http/health/404/error handler) and proves the error-handler invariant live (a throwaway thrown-error route, added and removed in the same session — see BUILD_LOG P0-4). |
| `src/config/env.js` | 🔒 Zod-validated environment. Exits the process at boot (readable error via `z.prettifyError`, not a raw stack) on anything missing or invalid — including a `QR_SIGNING_SECRET` that collides with either JWT secret (D-10). Mirrors `.env.example` exactly; loads `.env` from the repo root via Node's built-in `process.loadEnvFile()`, no `dotenv` dependency needed. `SMTP_PORT` is preprocessed to treat `""` as absent before coercion — `z.coerce.number()` otherwise turns an empty string into `0`, which fails `.positive()` (found live at P1-1, D-23). |
| `src/config/swagger.js` | `swagger-jsdoc` setup; scans `server/src/modules/**/*.routes.js` for `@openapi` JSDoc blocks and serves the interactive UI at `/api/docs` (+ raw spec at `/api/docs.json`). The glob is built and then forced to forward slashes even on Windows — `path.join()`'s backslashes make the underlying glob library match zero files silently (see Decisions Ledger D-19). |

### Database layer

| File | Purpose |
|---|---|
| `src/db/pool.js` | ⭐ The single `pg.Pool`. Configured max connections, idle timeout, and an `error` handler so a dropped backend doesn't crash the process. |
| `src/db/withTransaction.js` | 🔒⭐ `BEGIN`/`COMMIT`/`ROLLBACK` wrapper with `SET LOCAL statement_timeout` and a guaranteed `client.release()` in `finally`. **Every query function takes a `client`** — calling `pool.query` inside a transaction silently escapes it, which is the easiest way to break correctness with `pg`. Documented at the top of the file. Rollback and no-leak behavior verified live at P1-3 against a real Postgres connection — see `docs/TESTING.md`. |
| `src/db/migrate.js` | Thin wrapper around node-pg-migrate's programmatic `runner()` API (`up`/`down`/`reset` modes) — the CLI's own `--envPath` flag is a silent no-op without the `dotenv` package, which this project deliberately doesn't depend on (D-22). Backs `npm run db:migrate`, `db:migrate:down`, and `db:reset`. |
| `src/db/migrations/001_init.sql` | Enums, users, venues, seat categories, seats. |
| `src/db/migrations/002_events_shows.sql` | Events, shows, show prices. |
| `src/db/migrations/003_show_seats.sql` | ⭐ `show_seats`, `seat_holds`, and the indexes that make the sweep and availability queries fast. Header comment explains `UNIQUE (show_id, seat_id)`, the `reserved_until` column (D-14), and why `show_seats.booking_id` has no inline `REFERENCES` — `bookings` doesn't exist until 004; the constraint is added there instead. |
| `src/db/migrations/004_bookings.sql` | Bookings, booking seats, payments. Also adds the `show_seats.booking_id` foreign key deferred from 003. |
| `src/db/migrations/005_waitlist.sql` | ⭐ Waitlist entries, offers, and the FIFO index. |
| `src/db/migrations/006_outbox_audit.sql` | Outbox events, ticket scans, audit log. |
| `src/db/seed.js` | Demo data: 3 venues, 8 events, 20 shows, **one deliberately sold-out show** with a pre-populated waitlist, plus admin/organiser/customer accounts. Idempotent. Makes the demo instant. As of P1-7 ("seed skeleton"): just the 3 role accounts, via `ON CONFLICT (email) DO NOTHING` — venues/events/shows are added once their modules exist, Phase 2 onward. |

### Infrastructure

| File | Purpose |
|---|---|
| `src/notify/publisher.js` | ⭐ `pgNotify(client, channel, payload)` — called **inside** the caller's transaction, so a notification can only fire if the transaction commits. Services never emit to Socket.IO directly; they go through here. |
| `src/notify/listener.js` | ⭐ One long-lived `pg.Client` (not from the pool — a `LISTEN` connection is occupied) holding `LISTEN seat_changes`. Forwards payloads to the right Socket.IO room. Reconnects with backoff if the connection drops. |
| `src/queue/enqueue.js` | ⭐ `enqueueJob(client, type, payload, runAt)` — inserts into `job_queue` **inside the caller's transaction**, so a hold can never exist without its expiry job. |
| `src/queue/poller.js` | ⭐ Runs every `JOB_POLL_INTERVAL_MS` (started from `index.js` with an empty handler map as of P1-4 — real handlers register in as HOLD_EXPIRY/OFFER_EXPIRY/OUTBOX_SEND are built). Claims a batch with `FOR UPDATE SKIP LOCKED`, dispatches by type, marks DONE, or reschedules with exponential backoff via `utils/backoff.js`. DEAD after `JOB_MAX_ATTEMPTS`. This is the BullMQ replacement — the most reusable thing in the repo. Two-concurrent-claims-one-winner verified live at P1-4, 21 races — see `docs/TESTING.md`. |
| `src/queue/handlers/holdExpiry.js` | ⭐ Job type `HOLD_EXPIRY` → idempotent release. **Layer 2** of the TTL design. |
| `src/queue/handlers/offerExpiry.js` | ⭐ Job type `OFFER_EXPIRY` → cascade to the next entry in the queue. |
| `src/queue/handlers/outboxSend.js` | ⭐ Job type `OUTBOX_SEND` → renders and sends the email, marks the outbox row SENT/FAILED. |
| `src/jobs/holdReconciler.job.js` | ⭐ `node-cron` every 30s sweeping `state='HELD' AND expires_at <= now()`. **Layer 3** — the safety net under the safety net. Runs whether or not the poller is alive. |
| `src/jobs/offerReconciler.job.js` | Same for lapsed offers whose job row was lost. |
| `src/mail/mailer.js` | Nodemailer transport. In dev, auto-creates an **Ethereal** test account and logs the preview URL — no mail server to install. In prod, SMTP from env. Renders EJS → HTML, attaches the QR PNG via CID. |
| `src/mail/templates/bookingConfirmed.ejs` | Ticket email: event details, seats, total, embedded QR. |
| `src/mail/templates/waitlistOffer.ejs` | ⭐ Offer email: seats reserved, deadline, large Claim button. |
| `src/db/migrations/007_job_queue.sql` | ⭐ The `job_queue` table and its partial claim index. Header comment explains the `SKIP LOCKED` pattern. |
| `src/db/migrations/008_refresh_tokens.sql` | Added at P1-5, beyond §4.2's original schema — a hash-based allowlist backing refresh-token rotation and reuse detection. See Decisions Ledger D-27. |
| `src/mail/templates/bookingCancelled.ejs` | Cancellation + refund summary. |
| `src/mail/templates/offerExpired.ejs` | Courtesy notice that the window lapsed. |

### Middleware

| File | Purpose |
|---|---|
| `src/middleware/requireAuth.js` | Verifies the access token from the httpOnly cookie, attaches `req.user`. Verified live at P1-6 over real HTTP — see `docs/TESTING.md`. |
| `src/middleware/requireRole.js` | ⭐ RBAC. `requireRole('ADMIN')`. |
| `src/middleware/requireOwnership.js` | ⭐ Separate from RBAC: an organiser has the role *and* must own the event. Commonly missed — has its own test. As of P1-6: a generic, reusable factory taking a resource loader — no `events` table exists yet, so it was proven against a synthetic resource over temporary routes (added, tested, removed before commit), not a real event. Phase 2's event/show routes wire this up with a real loader. |
| `src/middleware/validate.js` | Runs a Zod schema against `body`/`query`/`params`, returns 422 with field details. `query` is replaced via `Object.defineProperty`, not plain assignment — Express 5 makes `req.query` a getter with no setter (D-31, found live at P2-4, the first route to validate a query string). |
| `src/middleware/idempotency.js` | ⭐ Replay protection via the `bookings.idempotency_key` unique column: on a duplicate-key violation, load and return the original booking instead of erroring. No cache layer needed — the constraint *is* the mechanism. |
| `src/middleware/errorHandler.js` | 🔒 Last in the chain. Maps domain errors to HTTP status + stable codes; unknown errors become a 500 with a logged correlation id and no stack leak. As of P1-5: checks `instanceof DomainError` and reads `.status`/`.code`/`.message` off it directly; anything else still falls through to the generic 500. As of P3-3: also reads `.details` (D-36) instead of hardcoding `null` — needed for `SeatsUnavailableError`'s conflicting-seats payload. This file grows with each addition; it doesn't get rewritten. |
| `src/middleware/rateLimit.js` | `express-rate-limit` configs: holds 10/min/user, auth 5/min/IP. |

### Modules

Each module is four files: `*.routes.js` (router + validation + Swagger JSDoc) → `*.controller.js` (req/res only) → `*.service.js` (business logic, transactions) → `*.queries.js` (raw SQL, takes a `client`). Keeping SQL in its own file is what makes the concurrency work reviewable.

| Module | Files | Notes |
|---|---|---|
| **auth** | `auth.routes.js`, `auth.controller.js`, `auth.service.js`, `auth.queries.js` | argon2 hashing, token issue and rotation, refresh reuse detection. Rotation and reuse detection verified live at P1-5 against the real DB — two real bugs found and fixed in the process, see Decisions Ledger D-25/D-26 and `docs/TESTING.md`. Backed by `migrations/008_refresh_tokens.sql` (D-27), added beyond §4.2's original schema since reuse detection needs a server-side allowlist, not just a stateless JWT. |
| **venues** | `venues.routes.js`, `venues.controller.js`, `venues.service.js`, `venues.queries.js` | Built at P2-1..P2-3. ADMIN-only writes (create venue/category/bulk-seats); ADMIN+ORGANISER reads (an organiser needs to browse venues/categories to build a show). Bulk seat creation is one `unnest()`-based `INSERT`, not one INSERT per seat — see `venues.queries.js#insertSeatsBulk`. Grid-coordinate and category-name collisions rely on the DB's `UNIQUE` constraints, caught and translated to `409 CONFLICT` — no client-side pre-validation (Phase 2 debt, `docs/BUILD_LOG.md`). |
| **events** | `events.routes.js`, `events.controller.js`, `events.service.js`, `events.queries.js` | Built at P2-4. `POST`/`PATCH` are ORGANISER + `requireOwnership`; browse/detail are public. `updateEventSchema` (`shared/schemas/event.schema.js`) is hand-written, NOT `createEventSchema.partial()` — `.partial()` doesn't strip Zod `.default()`, which was silently wiping `description` on a partial PATCH (Decisions Ledger D-32). Browse's `GET /events?...` query validation also caught a real Express 5 bug in `middleware/validate.js` (`req.query` has no setter — D-31), fixed there rather than worked around here. |
| **shows** | `shows.routes.js` (exports two routers — `eventShowsRouter` mounted at `/api/v1/events/:eventId/shows`, `showsRouter` mounted at `/api/v1/shows`), `shows.controller.js`, `shows.service.js`, `shows.queries.js` | Built at P2-5/P2-6. ⭐ `publishShow()` (`shows.service.js`) materialises one `show_seats` row per active venue seat in a single batched `INSERT ... SELECT` — the moment the seat map comes into existence. Idempotency is a check-then-act (`countShowSeats` before insert), backstopped by `UNIQUE (show_id, seat_id)` catching a genuine race as a clean `409` rather than corruption — see the WALKTHROUGH comment on `publishShow()`. `insertShow()`'s optional TTL columns needed a real fix mid-build: `COALESCE($n, DEFAULT)` isn't valid Postgres (D-30). |
| **seatmap** | `seatmap.routes.js`, `seatmap.controller.js`, `seatmap.service.js`, `seatmap.queries.js` | Built at P2-7. ⭐ Computes **effective** state — an expired `HELD` or `OFFER_RESERVED` renders as available regardless of the stored value. **Layer 1** of the TTL design (`docs/PROJECT_PROMPT.md` §5.2), live and proven (`docs/TESTING.md`) before Phase 3 exists to build Layers 2/3. Public, unauthenticated route. |
| | `seatState.machine.js` | 🔒⭐ Built at P3-1. `assertTransition(fromState, toState)` over the map in `shared/seatStates.js` — pure, synchronous, no DB. Every state change routes through it. Takes the seat's EFFECTIVE state, not necessarily its raw stored one (see the file's header on lazy expiry). |
| **holds** | `holds.routes.js` | `POST /` (P3-3) and `DELETE /:id` (P3-4, `requireAuth` + `requireOwnership` — only the hold's own user may release it). `GET /:id` still deferred to whichever task actually needs it. |
| | `holds.controller.js` | Built at P3-3, grew at P3-4 (`releaseHold` — always `200`, even for an idempotent no-op). Thin HTTP <-> `holds.service.js` translation; no business logic. |
| | `holds.service.js` | 🔒⭐ Built at P3-3 (`createHold()`); `releaseHold()` and `loadHoldForOwnership()` added at P3-4. `releaseHold()` carries the numbered WALKTHROUGH comment CLAUDE.md mandates for this exact function — the double-release no-op, why three layers racing to call it is the NORMAL case (§5.2, quoted), and the one easy-to-get-wrong case: releasing a STALE holdId whose seat was since reclaimed under a DIFFERENT hold cannot clobber the new holder, because both underlying queries key on hold-identity (`hold_id`/`id`), never on which seat a hold currently governs — proven live, not just reasoned about (`docs/TESTING.md`). TTL job-queue registration (P3-5) and socket broadcasting (P3-6) are explicitly commented as deferred, not silently missing. `createHold()`'s shortfall check carries the WHY comment naming D-35 directly: `acquireSeats()` is not itself all-or-nothing, this `ROLLBACK` is where "loser holds zero seats" actually comes from, and deleting the check because "the query already handles it" silently reintroduces a partial hold. |
| | `holds.queries.js` | 🔒⭐ Built at P3-2. **The most important file in the repo.** `acquireSeats()` — the `FOR UPDATE` CTE with deterministic `ORDER BY seat_id`, gating `OFFER_RESERVED` on `reserved_until` per D-14. Numbered WALKTHROUGH comment covers the happy path and both race outcomes — including the non-obvious one (D-35): an overlapping-set request's loser can get back a genuinely PARTIAL array, not empty; "loser holds zero" only becomes true once `holds.service.js` (P3-3) wraps this in a transaction and rolls back on any shortfall. This file's own contract stops at "exactly which rows this statement legally touched." Grew at P3-3 with `insertSeatHold()` (the parent `seat_holds` row, same transaction) and `findSeatLabels()` (turns unacquired seat ids into the 409's human-readable conflicting-seats list). Grew again at P3-4 with `releaseHoldSeats()` (keyed on `hold_id`), `markSeatHoldReleased()` (keyed on the hold's own `id`, never on a seat — see holds.service.js#releaseHold's WALKTHROUGH for why that specific distinction is what makes a stale release safe), and `findSeatHoldById()` (the one read-only function that also accepts a bare `pool`, for `loadHoldForOwnership`'s route-middleware use). |
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
| **health** | `health.routes.js` | DB connectivity, pool stats, `job_queue` pending/dead counts, outbox backlog, listener connected. Used by the platform health check. As of P0-4: liveness only (`{ status: 'ok' }`) — the subsystems it will report on don't exist yet. Full version lands at P9-3. |

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
| `src/utils/errors.js` | Domain error classes: `SeatsUnavailableError`, `HoldExpiredError`, `OfferInvalidError`, `IllegalSeatTransitionError`. Each carries its code from `shared/errors.js`. Created at P1-5 with a `DomainError` base class and auth's five error classes (`InvalidCredentialsError`, `EmailTakenError`, `UnauthenticatedError`, `ForbiddenError`, `RefreshInvalidError`) — the Phase 3 seat/booking classes named above arrive with their owning phase, extending this file rather than rewriting it. P2-1 added `NotFoundError`/`ConflictError`, generic and reused across venues/events/shows rather than one pair per resource — see "Phase 2 debt" in `docs/BUILD_LOG.md`. P3-1 added `IllegalSeatTransitionError` (409 — a judgment call, spec never pins a status; see Decisions Ledger D-33), the first of the four Phase-3 seat/booking classes `docs/FILE_MANIFEST.md` names. P3-3 added `SeatsUnavailableError` (carries `details.conflictingSeats`) and the reusable `ValidationError` (422 — for service-layer rules a shared Zod schema can't express, like `MAX_SEATS_PER_BOOKING`, which needs server-only env). Also at P3-3: `DomainError` itself gained an optional `details` field (D-36) — until now nothing on this path could hand the client structured data beyond a message string. |
| `src/utils/logger.js` | `pino` instance with correlation-id support. |
| `src/utils/asyncRoute.js` | Only needed if you end up on Express 4 — Express 5 forwards async rejections natively. |
| `src/utils/backoff.js` | Exponential backoff with jitter, shared by the job poller and the outbox handler. |

### Tests

| File | Purpose |
|---|---|
| `vitest.unit.config.js` | 🔒 Built at P3-9. Config for `tests/unit/**` only — no DB, safe to run fully parallel. Split from `vitest.e2e.config.js` because the two suites have opposite concurrency needs (see that file). |
| `vitest.e2e.config.js` | 🔒 Built at P3-9. Config for `tests/e2e/**` — loads `tests/setup/testEnv.js` via `setupFiles` and sets `fileParallelism: false`, since every e2e file shares one real Postgres database and truncates it between tests. `testTimeout`/`hookTimeout` raised to 30s — a real 50-way row-lock race genuinely takes a few seconds. |
| `tests/setup/testEnv.js` | 🔒⭐ Built at P3-9. Owns pointing the process at `ticket_booking_test` **before** `src/db/pool.js` ever reads `DATABASE_URL` — registered as a Vitest `setupFiles` entry specifically so its whole module body finishes before a test file's own imports (which transitively reach `pool.js`) are evaluated. Derives the test DB name from `DATABASE_URL` by checking whether it already ends in `_test` before appending — CI's Postgres service container is already named `ticket_booking_test`, so appending unconditionally would derive a database that doesn't exist. See that file's header for the full ESM-import-ordering reasoning this split exists to satisfy. |
| `tests/setup/testDb.js` | 🔒⭐ Built at P3-9. `migrateTestDb()` (runs `node-pg-migrate`'s `runner()` directly, NOT by importing `src/db/migrate.js` — that file's top-level code calls `process.exit(0)`, which would kill the Vitest worker), `truncateAllTables()`, and `closeTestDb()`. Both of the first two refuse to run unless `current_database()` itself ends in `_test` — a DB-level guard beyond `testEnv.js`'s own string check, since this is the single most destructive statement in the whole test suite. |
| `tests/setup/fixtures.js` | Built at P3-9. `registerAndLogin()`, `createAdminAndLogin()` (ADMIN can't self-register — D-28 — so this inserts the row directly, then logs in through the real endpoint), and `buildBookableShow()` — drives the real venue → category → seats → event → show → publish HTTP sequence once so e2e test files don't each repeat it by hand. |
| `tests/unit/seatState.machine.test.js` | Built at P3-1 — the project's first automated test (Vitest, added this task; `tests/setup/testDb.js` and the DB-backed suites still land at P3-9). Full 5×5 legal/illegal transition matrix, with the expected set hand-written independently of `SEAT_TRANSITIONS` so it catches spec drift, not just guard-function bugs. Also asserts `SEAT_TRANSITIONS` is deep-frozen (outer map and every per-state array). |
| `tests/unit/offerToken.test.js` | Token generation, hashing, tamper and replay rejection. |
| `tests/unit/reference.test.js` | 100k references, zero collisions, no ambiguous characters. |
| `tests/e2e/auth.test.js` | Registration, login, refresh rotation, RBAC and ownership denials. |
| `tests/e2e/bookingFlow.test.js` | Browse → hold → confirm → outbox row → QR present. Also owns §6.6's "20 parallel confirms" and "confirm at `expires_at+1ms`" scenarios once Phase 4 builds `confirmBooking()` — not buildable at P3-9 (see `docs/PROJECT_PROMPT.md` §6.6's table). |
| `tests/e2e/holdExpiry.test.js` | ⭐ Built at P3-9, grew a second test at the Phase 3 close-out audit. Test 1: a `HELD` seat manually rewound past its `expires_at`, zero schedulers of any kind running (Layers 2/3 deferred) — `GET /shows/:id/seatmap` still reports `AVAILABLE` (the READ side of Layer 1). Test 2: the WRITE side the audit found missing — the same rewound seat is acquired by a SECOND user's real `POST /holds`, which must succeed (not `409`) and transfer `hold_id` to the new hold. Falsified live: deleting `acquireSeats()`'s `(state='HELD' AND expires_at<=now())` OR-branch made test 2 fail (`409` instead of `201`) while test 1 and the rest of the suite stayed green — proving the phase's "seats free themselves" exit criterion now has a test that actually depends on the mechanism, not just the read-side CASE expression. |
| `tests/e2e/concurrency.test.js` | ⭐⭐ Built at P3-9. Three of §6.6's six scenarios, the ones buildable with only the holds module (through P3-4): 50 parallel holds on one seat → exactly 1 winner; the overlapping `{A1,A2}`/`{A2,A3}` race → one full winner, the other holds zero seats (verified via the `seat_holds` row count, not just HTTP status — Decisions Ledger D-35); a public hold against an `OFFER_RESERVED` seat whose `expires_at` has lapsed but `reserved_until` hasn't (D-14) → `409`, seat untouched. Falsified live before being trusted (same convention as P3-1's `SEAT_TRANSITIONS` proof): temporarily stripped `holds.queries.js#acquireSeats`'s state predicate down to `WHERE s.id = c.id`, re-ran, and all three tests failed for the expected reason (50/50 winners, both racers winning, the `OFFER_RESERVED` seat handed out) — then the predicate was restored and confirmed byte-for-byte unchanged (`git status` empty on that file) before this suite was considered done. 20 parallel confirms, overlapping-set confirms, and the waitlist race are NOT in this file — see `tests/e2e/bookingFlow.test.js`/`waitlist.test.js` above and `docs/PROJECT_PROMPT.md` §6.6. |
| `tests/e2e/holds.test.js` | ⭐ Added at the Phase 3 close-out audit — P3-4's `releaseHold()` mechanisms had been proven live (session scripts, `docs/TESTING.md`) but never converted to a permanent test. Three cases: idempotent double/triple release (`{released:0}`, never an error, on the 2nd/3rd `DELETE` of the same holdId); a non-owner's `DELETE` → `403 FORBIDDEN`, seat state untouched; a stale holdId whose seat was reclaimed under a brand-new hold via the REAL `createHold()` path — releasing the stale hold must leave the NEW hold's own `seat_holds` row `ACTIVE` and its seat untouched. Falsified live: temporarily changed `markSeatHoldReleased()`'s predicate from `WHERE id = $1` to `WHERE show_id = (SELECT show_id FROM seat_holds WHERE id = $1)` (matching "the show's currently active hold" instead of "this specific hold") — the stale-holdId test's assertion on the new hold's status caught it immediately (`'RELEASED'` instead of `'ACTIVE'`), a real, silent corruption of a live, unrelated hold with no error and no 4xx. Predicate restored, confirmed byte-for-byte unchanged. |
| `tests/e2e/waitlist.test.js` | ⭐ Cancel → offer → accept; expiry → cascade; 10 users racing one link → 1 winner. Owns §6.6's "10 waitlisted users racing one offer" scenario once Phase 5 builds the waitlist/offers module — not buildable at P3-9. |
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
| `TESTING.md` | How to create `ticket_booking_test`, run the concurrency suite, and read its output. **Notes that the dev server must be stopped first** — 4 GB does not stretch to both. Created at P1-4 with the `db:migrate`/`db:reset` workflow and the P1-3/P1-4 concurrency proof output pasted verbatim; the real `ticket_booking_test` truncate-between-tests harness section lands with the first Vitest suite. |
| `DEPLOYMENT.md` | Local environment reproduction (Postgres install, database creation, `postgresql.conf` tuning for 4GB, `DATABASE_URL`) — written at P0-3. Production section (Render/Railway for the API + managed Postgres, Vercel/Netlify for the client; one database, no Redis add-on, no Dockerfile needed) lands at P10-6. |

---

## Sanity checks

Roughly 140–160 files. If a module needs more than its four standard files plus one, it's doing too much.

**The one rule that matters:** `holds.queries.js` keeps the atomic acquire as **one SQL statement**. If it grows, extract *around* it — never split it. Splitting it into read-then-write is the exact bug this entire design exists to prevent.