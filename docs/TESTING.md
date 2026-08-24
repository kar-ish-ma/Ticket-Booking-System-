# Testing

## Stop the dev server first

This machine has 4 GB of RAM. The dev server, Vite, and a real Postgres-backed test run were
never meant to fit at once — stop `npm run dev:server` (and `dev:client`, once it exists) before
running anything below.

## Migrations: up, down, and reset

```
npm run db:migrate        # apply every pending migration
npm run db:migrate:down   # revert exactly one migration
npm run db:reset          # revert every migration, then re-apply every migration
```

`db:reset` exists specifically so migration reversibility stays a claim that's actually re-tested
every time a migration is added, not just true the day it was written. As the schema grows past
today's 7 migrations, `db:reset` is what proves migration 12's `down()` doesn't quietly depend on
something migration 4 left behind — it tears everything down to nothing and rebuilds it from
scratch in one command.

Internally, `db:reset` loops single-step `down` calls until node-pg-migrate reports nothing left
to revert, then runs a normal `up`. There's no "revert everything" count node-pg-migrate documents
directly, and guessing a number "large enough" would be exactly the kind of magic-number
fragility this project avoids elsewhere — a loop can't under- or over-shoot.

All three commands need a real `.env` at the repo root with a working `DATABASE_URL` (see
`docs/DEPLOYMENT.md`). They use `server/src/db/migrate.js`, a thin wrapper around
node-pg-migrate's programmatic `runner()` API rather than its CLI directly — see Decisions
Ledger D-22 for why the CLI's own `--envPath` flag doesn't work in this project.

Real local `ticket_booking_test` database setup and the truncate-between-tests harness
(`tests/setup/testDb.js`) land with the first real Vitest suite (Phase 1 onward) — this section
will grow to cover running that suite once it exists.

## Concurrency proofs so far

Full concurrency test infrastructure (`tests/e2e/concurrency.test.js`, the headline 50-parallel-
hold suite) is Phase 3 work. Two lower-level mechanisms already exist in Phase 1, though, and were
verified live against the real `ticket_booking` database rather than taken on faith — pasted
here in full because this is exactly the kind of evidence a grader should be able to read without
having to run anything themselves.

### `withTransaction`: a thrown error actually rolls back, and the client is actually released

```
--- pool state BEFORE any transaction --- { totalCount: 0, idleCount: 0, waitingCount: 0 }
--- pool state AFTER failed transaction #1 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
--- pool state AFTER failed transaction #2 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
--- pool state AFTER failed transaction #3 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
--- pool state AFTER failed transaction #4 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
--- pool state AFTER failed transaction #5 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
--- pool state AFTER failed transaction #6 --- { totalCount: 1, idleCount: 1, waitingCount: 0 }
```

`idleCount` — not just `totalCount` — returns to 1 after every single failed transaction. That
distinction matters: `totalCount` alone can't tell "no leak" apart from "one client permanently
checked out and never coming back"; `idleCount` returning to 1 each time proves the same client is
actually back in the pool, available for the next caller, not just still counted as existing.

A companion run inserted a real row inside a transaction that then threw, and confirmed it:

```
--- row visible INSIDE the transaction, before throw ---
[
  {
    id: '8bb35083-c5dc-4457-bee4-5a13b39bf6ef',
    email: 'rollback-probe@example.com',
    password_hash: 'x',
    name: 'Probe',
    phone: null,
    role: 'CUSTOMER',
    created_at: 2026-08-23T17:06:42.899Z
  }
]
--- error propagated to caller? --- deliberate probe error
--- row visible AFTER the throw (should be zero rows if ROLLBACK worked) ---
[]
```

### The job queue poller: two concurrent claims on one job, exactly one winner

```
--- inserted job --- 7950ac25-38bd-4f45-8029-8bea94151880
--- claim A got --- [ '7950ac25-38bd-4f45-8029-8bea94151880' ]
--- claim B got --- []
--- exactly one claimed it? --- true
--- final DB state of the job --- [
  {
    id: '7950ac25-38bd-4f45-8029-8bea94151880',
    status: 'RUNNING',
    attempts: 1
  }
]
--- 20-iteration stress: doubleClaims=0 zeroClaims=0 (both must be 0) ---
```

Two `claimJobs()` calls fired genuinely concurrently (`Promise.all`, not sequential `await`s) on
a single shared job row, 21 times total (1 detailed run + a 20-iteration stress loop). Every time,
exactly one call claimed the job and the other claimed nothing — never both, never neither. This
is the same `FOR UPDATE SKIP LOCKED` primitive the waitlist cascade will use in Phase 5; proving it
here is proving the pattern, not just this one call site.

### Refresh-token rotation and reuse detection (P1-5)

This is the proof run that found two real bugs, both fixed before this was recorded — see
Decisions Ledger D-25 and D-26. What's pasted below is the output *after* both fixes, run against
the real `ticket_booking` database via `auth.service.js` directly (no HTTP layer in between, to
remove any doubt about what was actually exercised):

```
--- R1 (from register) --- l8XCRsDxtVso
--- R2 (from rotation of R1) --- JT-1Uxh4Akpg
--- DB state after rotation 1 ---
┌─────────┬──────────────────────────────────────┬───────────────────────────┬───────────────────────────┐
│ (index) │ id                                    │ revoked_at                │ created_at                 │
├─────────┼──────────────────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 0       │ 'cc5152d1-55f3-4510-a544-0ad5ccd34e8a'│ 2026-08-23T19:18:20.285Z  │ 2026-08-23T19:18:20.256Z  │
│ 1       │ '0823a58f-2bca-47e1-893c-caa653ded75f'│ null                      │ 2026-08-23T19:18:20.285Z  │
└─────────┴──────────────────────────────────────┴───────────────────────────┴───────────────────────────┘
--- Replaying R1 (already-rotated) — expect reuse detection ---
Correctly threw: Refresh token reuse detected; all sessions revoked
--- DB state after replaying R1 ---
┌─────────┬──────────────────────────────────────┬───────────────────────────┬───────────────────────────┐
│ (index) │ id                                    │ revoked_at                │ created_at                 │
├─────────┼──────────────────────────────────────┼───────────────────────────┼───────────────────────────┤
│ 0       │ 'cc5152d1-55f3-4510-a544-0ad5ccd34e8a'│ 2026-08-23T19:18:20.285Z  │ 2026-08-23T19:18:20.256Z  │
│ 1       │ '0823a58f-2bca-47e1-893c-caa653ded75f'│ 2026-08-23T19:18:20.305Z  │ 2026-08-23T19:18:20.285Z  │
└─────────┴──────────────────────────────────────┴───────────────────────────┴───────────────────────────┘
--- Now trying R2 (should be revoked by the family-wide reuse response) ---
Correctly threw: Refresh token reuse detected; all sessions revoked
--- Final DB state ---
(unchanged from the previous table — no new row was created; R2's own attempt correctly failed
 instead of succeeding and issuing an R3)
```

R2 — the token issued by rotating R1 — shows `revoked_at` set *immediately after* replaying R1,
before R2 was ever itself presented again. That's the family-wide revocation actually taking
effect. Presenting R2 afterward correctly fails as reuse too, and no further row is created. A
companion run confirmed R1 and R2 share the same `family_id` before any of this (`true`), so the
revocation is provably reaching every token in the family, not coincidentally hitting one row.

### RBAC and ownership (P1-6)

No `events` table exists yet (Phase 2), so "organiser → someone else's event" was tested against
a synthetic resource — `requireOwnership(async (req) => ({ ownerId: req.params.ownerId }))` — via
two temporary routes added to `app.js`, exercised over real HTTP, then removed before committing
(same pattern as the P0-4 error-handler proof). This tests the actual reusable middleware
(`requireAuth`, `requireRole`, `requireOwnership`) that Phase 2's real event/show routes will
wire up, not a mock of it:

```
=== No auth at all -> expect 401 UNAUTHENTICATED ===
{"success":false,"data":null,"error":{"code":"UNAUTHENTICATED","message":"No access token","details":null}}

=== CUSTOMER -> organiser-only route -> expect 403 FORBIDDEN ===
{"success":false,"data":null,"error":{"code":"FORBIDDEN","message":"You do not have access to this resource","details":null}}

=== ORGANISER -> organiser-only route -> expect 200 ===
{"success":true,"data":{"ok":true},"error":null}

=== ORGANISER -> ownership check on THEIR OWN id -> expect 200 ===
{"success":true,"data":{"ok":true},"error":null}

=== ORGANISER -> ownership check on SOMEONE ELSE's id (the customer's) -> expect 403 FORBIDDEN ===
{"success":false,"data":null,"error":{"code":"FORBIDDEN","message":"You do not own this resource","details":null}}
```

All five outcomes match the middleware chain's design exactly: no session fails auth before role
is even checked; the right role with the wrong resource still fails; the right role with the
right resource succeeds.

## Phase 2: venues, events, shows, seat map (P2-1 to P2-7)

No Vitest harness exists yet (still P3-9's job), so every mechanism below was proven live against
the real `ticket_booking` database and a real running server (`node server/src/index.js`), driven
with `curl` and short one-off Postgres probe scripts. Full request/response bodies, not summaries.

### Category and seat-grid conflicts (P2-2, P2-3)

```
--- create category Standard --- 201, category returned
--- create category Premium  --- 201, category returned
--- duplicate category name (re-POST "Standard") ---
{"success":false,"data":null,"error":{"code":"CONFLICT","message":"A category named \"Standard\" already exists for this venue","details":null}}
HTTP 409

--- bulk create seats: row A (Premium x5), row B (Standard x5) --- 201, 10 seats returned
--- colliding grid coords: row C at gridRow:1 (already used by row A) ---
{"success":false,"data":null,"error":{"code":"CONFLICT","message":"One or more seats collide with an existing seat number or grid position","details":null}}
HTTP 409
```

The colliding request wrote zero seats — `venues.service.js#bulkCreateSeats` wraps the whole
`unnest()` insert in `withTransaction`, so the constraint violation on row C rolled the entire
call back, not just the offending row.

### Show creation, ownership, and publish (P2-4, P2-5, P2-6)

```
--- organiser creates event --- 201
--- admin tries POST /events (role-gated to ORGANISER) ---
{"success":false,"data":null,"error":{"code":"FORBIDDEN","message":"You do not have access to this resource","details":null}}
HTTP 403

--- second organiser PATCHes the first organiser's event ---
{"success":false,"data":null,"error":{"code":"FORBIDDEN","message":"You do not own this resource","details":null}}
HTTP 403

--- create show with 2 category prices, holdTtlSeconds/offerTtlSeconds omitted --- 201
  "holdTtlSeconds":600,"offerTtlSeconds":900   <- DB column defaults applied correctly (post D-30 fix)

--- admin (not the event's organiser) tries POST /shows/:id/publish ---
{"success":false,"data":null,"error":{"code":"FORBIDDEN","message":"You do not have access to this resource","details":null}}
HTTP 403

--- organiser publishes the show ---
{"success":true,"data":{"show":{...,"status":"SCHEDULED"},"seatCount":10},"error":null}

--- organiser publishes the SAME show again ---
{"success":false,"data":null,"error":{"code":"CONFLICT","message":"This show has already been published","details":null}}
HTTP 409

--- create show under a nonexistent eventId ---
{"success":false,"data":null,"error":{"code":"NOT_FOUND","message":"Resource not found","details":null}}
HTTP 404
```

`seatCount: 10` matches the 10 seats created in the bulk-seat step exactly — one `show_seats` row
per active venue seat, all defaulting to `AVAILABLE`, from the single `INSERT ... SELECT` in
`shows.queries.js#materialiseShowSeats`.

### Browse filters and the PATCH data-corruption bug (P2-4, D-31, D-32)

Two real bugs were caught here, not just filter combinations exercised:

```
--- GET /events?type=MOVIE&city=Testville (before any fix) ---
{"success":false,"data":null,"error":{"code":"INTERNAL_ERROR", ...}}
   server log: TypeError: Cannot set property query of #<IncomingMessage> which has only a getter
   (Express 5's req.query has no setter — see D-31)

--- after fixing validate.js (Object.defineProperty for the query source) ---
--- GET /events?type=MOVIE&city=Testville --- 200, our event returned, total: 1
--- GET /events?city=Nowhere              --- 200, events: [], total: 0
--- GET /events?q=Nonexistent             --- 200, events: [], total: 0
--- GET /events?page=notanumber ---
{"success":false,"data":null,"error":{"code":"VALIDATION_ERROR","message":"Invalid request",
 "details":[{"code":"invalid_type","expected":"number","received":"NaN","path":["page"], ...}]}}
HTTP 422

--- PATCH /events/:id { isPublished: true } only, on an event created with description:"A test film" ---
--- GET /events/:id afterward: description is now "" ---
   (updateEventSchema = createEventSchema.partial() still carried description's .default('') —
    see D-32. Fixed by hand-writing updateEventSchema with no field carrying .default().)

--- after the fix: PATCH { isPublished: false } (again omitting every other field) ---
--- GET /events/:id afterward: title "Test Movie", type "MOVIE", durationMin 120 all UNCHANGED ---
   (description stays "" from the earlier corruption — pre-existing test data, not a new bug;
    the fix is proven by the fields that were never mentioned in either PATCH surviving intact.)
```

### P2-7: seatmap effective state — the lazy-expiry proof

The core claim (§5.1 of `docs/PROJECT_PROMPT.md`): a hold is expired because the clock says so,
not because a worker said so. Phase 3 doesn't exist yet — no poller, no cron reconciler, nothing
that could flip a stale row back to `AVAILABLE` on its own. This proof forces a `show_seats` row
into a state Layer 2/3 would normally clean up, then reads it through nothing but the effective-
state SQL in `seatmap.queries.js`, with no worker anywhere in the process.

**Step 1 — force one seat into a stale HELD state, directly in Postgres, and prove the write:**

```
--- BEFORE manual UPDATE ---
{
  "id": "66ca43bb-0c01-48d3-9536-c89c05e7cb9a",
  "state": "AVAILABLE",
  "expires_at": null,
  "db_now": "2026-08-23T19:52:14.285Z"
}
--- RAW SQL UPDATE RESULT ---
-- UPDATE show_seats SET state = 'HELD', expires_at = now() - interval '1 hour', ...
-- RETURNING id, state, expires_at, (expires_at <= now()) AS is_past
rowCount: 1
{
  "id": "66ca43bb-0c01-48d3-9536-c89c05e7cb9a",
  "state": "HELD",
  "expires_at": "2026-08-23T18:52:14.296Z",
  "is_past": true
}
```

**Step 2 — read the seat map over real HTTP, no auth, nothing but the running server:**

```
GET /api/v1/shows/492b94a9-198a-4bbd-8dba-9af351824a30/seatmap

{
  "showSeatId": "66ca43bb-0c01-48d3-9536-c89c05e7cb9a",
  "seatId": "d011fd64-3e9f-452c-8ec7-03f956c042c0",
  "categoryId": "ba63104a-0bc2-45cb-9cb4-2425167f6cc1",
  "rowLabel": "A",
  "seatNumber": 1,
  "gridRow": 1,
  "gridCol": 0,
  "isAccessible": false,
  "state": "AVAILABLE",
  "categoryName": "Premium",
  "categoryColorHex": "#f59e0b",
  "priceCents": 1500
}
```

**Step 3 — re-query the raw row AFTER the HTTP call, to rule out anything else having touched it:**

```
--- RAW STORED ROW, queried AFTER the seatmap GET above ---
{
  "id": "66ca43bb-0c01-48d3-9536-c89c05e7cb9a",
  "state": "HELD",
  "expires_at": "2026-08-23T18:52:14.296Z",
  "db_now": "2026-08-23T19:52:33.708Z",
  "is_past": true
}
```

The row is still, genuinely, stored as `HELD` with `expires_at` in the past — nothing rewrote it.
The API nonetheless reported `AVAILABLE`. The only code path that could produce that is the `CASE`
expression in `seatmap.queries.js#getEffectiveSeatMap`:
`WHEN ss.state = 'HELD' AND ss.expires_at <= now() THEN 'AVAILABLE'`. That predicate, evaluated
fresh on every read, is the entirety of Layer 1 — no scheduler, no cron, no job queue involved,
because none of those exist yet. The row was reset to `AVAILABLE`/`NULL` immediately after this
proof so Phase 3 starts from a clean seat map.

## Phase 3: seat holds, TTL, concurrency (P3-1, P3-2)

### P3-1 — full transition matrix (Vitest)

```
Test Files  1 passed (1)
     Tests  31 passed (31)
```

25 pairs (5×5), 2 unrecognised-state cases, 4 immutability cases — full output in the P3-1
commit's own BUILD_LOG row. Falsified live: deleting the `OFFER_RESERVED → OFFER_RESERVED`
cascade entry from `SEAT_TRANSITIONS` broke exactly one test (that pair), nothing else.

### P3-2 — `acquireSeats()`, the atomic hold acquisition

No Vitest-DB harness exists yet (`tests/setup/testDb.js` is explicitly P3-9's job — see Decisions
Ledger D-34), so this was proven with a throwaway Node script run directly against the real
`ticket_booking` database, then deleted before committing — same pattern Phases 0–2 used for
every DB-dependent mechanism. Each scenario below seeds its own isolated `show_seats` row(s) so
none of them can interfere with each other.

**Scenarios 1–6 — the single-statement predicate, one case at a time:**

```json
{
  "scenario1_available_acquired": ["6a933956-...-f8ec7489a010"],
  "scenario2_heldNotExpired_rejected": [],
  "scenario3_heldExpired_reclaimed": ["a28792fa-...-3127caddeb64"],
  "scenario4_offerReserved_beforeReservedUntil_rejected_D14": [],
  "scenario5_offerReserved_afterReservedUntil_reclaimed_D14": ["e66a5cf2-...-0b17898ce838"],
  "scenario6_multiSeat_partial_oneAvailableOneHeld": ["76a0fd38-...-a7bf8d0cffe3"]
}
```

Scenario 2 (seat already `HELD`, not expired) and scenario 4 (seat `OFFER_RESERVED`, its current
cascade attempt's `expires_at` already past but `reserved_until` still in the future) both come
back as empty arrays — the acquire predicate correctly refuses both. **Scenario 4 is the literal
D-14 check**: it proves the predicate gates on `reserved_until`, not `expires_at`, for
`OFFER_RESERVED` — a public hold cannot snipe a seat mid-cascade just because one attempt lapsed.
Scenario 5 (both timestamps past) correctly reclaims it. Scenario 6 — a 2-seat request where only
one seat is actually acquirable — returns a 1-element array, not an exception and not an empty
array: `acquireSeats()` signals partial success by array length, exactly as its own JSDoc
promises (`@throws never`).

**Scenario 7 — a genuine 2-way race on ONE seat, via `Promise.all`:**

```json
{
  "userA_result": ["a614615f-...-7c6976fa0977"],
  "userB_result": []
}
```

Exactly one winner, one empty loser, every run — the ordinary single-seat race case §6.6 also
covers (at small scale here; the full 50-parallel version is P3-9's).

**Scenario 8 — the one only `ORDER BY seat_id` can prevent: an overlapping-set race.**

A single-seat race can't exercise lock ordering at all (both transactions want the same one
lock). `{X1,X2}` vs `{X2,X3}` — sharing X2 — is the smallest case that can, and if the ordering
were wrong, the failure mode is a Postgres deadlock error (`40P01`), not merely a wrong result —
which is exactly why this is worth proving here, in isolation, rather than waiting for it to
possibly show up buried inside P3-9's 50-parallel suite.

Each racer is wrapped in a **throwaway** "simulate P3-3" transaction — `BEGIN` → `acquireSeats()`
→ roll back on any shortfall, else commit. This wrapper is proof-script scaffolding only, deleted
with the rest of the script; `holds.service.js#createHold` (P3-3) is where this logic is actually
built as production code.

One representative run:

```json
{
  "requestedByA": ["X1", "X2"],
  "requestedByB": ["X2", "X3"],
  "resultA": {
    "rawAcquiredByThisStatement": ["c0e28e99-...", "dfed6e26-..."],
    "effectiveResultAfterRollback": ["c0e28e99-...", "dfed6e26-..."],
    "rolledBack": false
  },
  "resultB": {
    "rawAcquiredByThisStatement": ["0e3156a2-..."],
    "effectiveResultAfterRollback": [],
    "rolledBack": true
  }
}
```

**This is the finding behind Decisions Ledger D-35.** B's *raw* `acquireSeats()` call did not
come back empty — it came back with one seat (X3, the one nobody else wanted). B lost only the
contested seat (X2); the function has no way to know, and no contract to decide, that B's overall
*request* should therefore fail. Only the wrapper — noticing `1 seat acquired < 2 requested` —
rolls the whole transaction back, and only *then* does B's effective result become the empty
array §6.6 describes. `acquireSeats()`'s real, narrower contract is "exactly which rows this
statement legally touched"; "the loser holds zero" is an emergent property of the caller's
transaction discipline, not of this function alone.

Final DB state after that same run, queried fresh (not from the transaction that wrote it):

```json
[
  { "seat_number": 1, "state": "HELD", "held_by_a": true,  "held_by_b": false },
  { "seat_number": 2, "state": "HELD", "held_by_a": true,  "held_by_b": false },
  { "seat_number": 3, "state": "AVAILABLE", "held_by_a": null, "held_by_b": null }
]
```

A won both seats it asked for; B's tentative claim on X3 was fully undone by its rollback — X3 is
back to `AVAILABLE`, not stuck `HELD` with no owner. **Run 8 times** to rule out a lucky single
result:

```
RUN 1: winner A? true  | winner B? false | noDeadlock: true | exactlyOneFullWinner: true | HELD,HELD,AVAILABLE
RUN 2: winner A? false | winner B? true  | noDeadlock: true | exactlyOneFullWinner: true | AVAILABLE,HELD,HELD
RUN 3: winner A? false | winner B? true  | noDeadlock: true | exactlyOneFullWinner: true | AVAILABLE,HELD,HELD
RUN 4: winner A? true  | winner B? false | noDeadlock: true | exactlyOneFullWinner: true | HELD,HELD,AVAILABLE
RUN 5: winner A? true  | winner B? false | noDeadlock: true | exactlyOneFullWinner: true | HELD,HELD,AVAILABLE
RUN 6: winner A? true  | winner B? false | noDeadlock: true | exactlyOneFullWinner: true | HELD,HELD,AVAILABLE
RUN 7: winner A? true  | winner B? false | noDeadlock: true | exactlyOneFullWinner: true | HELD,HELD,AVAILABLE
RUN 8: winner A? false | winner B? true  | noDeadlock: true | exactlyOneFullWinner: true | AVAILABLE,HELD,HELD
```

Both winners occur across the 8 runs (it's a genuine race, not a fixed outcome), zero deadlocks,
and the final DB state is always exactly one of the two valid configurations — never three seats
in an inconsistent mix, never a row left `HELD` with no owner.

### P3-3 — `POST /api/v1/holds`, over real HTTP

Everything below is a genuine E2E proof: a real `node server/src/index.js` process, real
`fetch()` calls from a throwaway Node script (not committed — same pattern as every DB-dependent
mechanism so far; the permanent Supertest/`testDb.js` harness is still P3-9's job, D-34), real
cookies from `POST /auth/register`, against the real `ticket_booking` database.

**Scenario A — an available seat:**

```json
{ "status": 201, "body": { "success": true, "data": {
  "hold": { "id": "e7b48812-...", "expiresAt": "2026-08-23T21:01:59.571Z" },
  "seatIds": ["5c605708-...-78d5fd03d326"]
}, "error": null } }
```

**Scenario B — one available seat + one already held by someone else (not expired):**

```json
{
  "status": 409,
  "body": {
    "success": false, "data": null,
    "error": {
      "code": "SEATS_UNAVAILABLE",
      "message": "One or more requested seats are unavailable",
      "details": { "conflictingSeats": [{ "seatId": "658aae97-...", "rowLabel": "X", "seatNumber": 2 }] }
    }
  },
  "seatHoldsCountBefore": 0,
  "seatHoldsCountAfter": 0,
  "x1StateAfter": "AVAILABLE"
}
```

`error.details.conflictingSeats` names exactly the one seat that was actually taken — not both
requested seats, not a generic "unavailable" with no detail. **The addition requested in
review**: `seatHoldsCountAfter` is `0`, same as before the request — the parent `seat_holds` row
`createHold()` inserts *before* calling `acquireSeats()` is genuinely gone after the rollback, not
an orphaned `ACTIVE` hold owning zero seats. And `x1StateAfter` is `AVAILABLE`: the seat that
*would* have been acquired reverted fully — this is not a "keep what you could get" partial
success, it's a real all-or-nothing rollback.

**Scenario C — `MAX_SEATS_PER_BOOKING`:**

```json
{ "status": 422, "body": { "success": false, "data": null,
  "error": { "code": "VALIDATION_ERROR", "message": "Cannot hold more than 6 seats at once", "details": null } } }
```

**Scenario D — the overlapping-set race, `{X1,X2}` vs `{X2,X3}`, over real concurrent HTTP
(`Promise.all`), run 6 times:**

```
Run 1: A=201 B=409(conflict: seat 2) seat_holds rows=1 | HELD,HELD,AVAILABLE
Run 2: A=201 B=409(conflict: seat 2) seat_holds rows=1 | HELD,HELD,AVAILABLE
Run 3: A=201 B=409(conflict: seat 2) seat_holds rows=1 | HELD,HELD,AVAILABLE
Run 4: A=201 B=409(conflict: seat 2) seat_holds rows=1 | HELD,HELD,AVAILABLE
Run 5: A=201 B=409(conflict: seat 2) seat_holds rows=1 | HELD,HELD,AVAILABLE
Run 6: A=409(conflict: seat 2) B=201 seat_holds rows=1 | AVAILABLE,HELD,HELD
```

Every run: exactly one `201` (always with 2 seats), one `409` (its `conflictingSeats` always
names seat 2, the contested one — never seat 1 or seat 3, which were never at risk), and
`seat_holds` row count is **always exactly 1** — never 0 (the winner's row must survive), never 2
(the loser's row must not). Final DB state is always exactly one of the two valid configurations.
Run 6 shows B winning instead of A, confirming this is a genuine race and not a fixed
first-request-wins outcome.

This re-proves D-35's finding at the full HTTP stack, with the real production rollback (not
P3-2's throwaway wrapper): `createHold()`'s shortfall check is what turns `acquireSeats()`'s
per-row partial result into the system-level "loser holds zero" guarantee §6.6 describes.

### P3-4 — `DELETE /api/v1/holds/:id`, idempotent release

Same method as P3-3: a real server, real HTTP, real cookies, the real `ticket_booking` DB. No
broadcast verification — P3-6 (`pg_notify`/`LISTEN`) is deferred, so `releaseHold()` doesn't call
it yet; every assertion here is DB-state only.

**Scenario 1 — normal release, then a double and triple release on the same holdId:**

```json
{
  "createStatus": 201,
  "del1": { "status": 200, "body": { "success": true, "data": { "released": 1 } } },
  "stateAfterDel1": { "state": "AVAILABLE", "hold_id": null, "held_by_user_id": null },
  "holdRowAfterDel1": { "status": "RELEASED" },
  "del2": { "status": 200, "body": { "success": true, "data": { "released": 0 } } },
  "del3": { "status": 200, "body": { "success": true, "data": { "released": 0 } } }
}
```

The first `DELETE` frees the seat and marks the `seat_holds` row `RELEASED`. The second and
third — same holdId, same request — return `200 {released: 0}` both times: no error, no special
"already released" branch anywhere in the code, just the same two `UPDATE` predicates finding
nothing left to match.

**Scenario 2 — a non-owner cannot release someone else's hold:**

```json
{
  "delByB": { "status": 403, "body": { "error": { "code": "FORBIDDEN", "message": "You do not own this resource" } } },
  "stateAfter": { "state": "HELD", "hold_id": "776d1b3c-...", "held_by_user_id": "a060bea7-..." }
}
```

The seat's state is completely unchanged by the forbidden attempt — `requireOwnership` blocked it
before `releaseHold()` ever ran.

**Scenario 3 — a nonexistent holdId:**

```json
{ "status": 404, "body": { "error": { "code": "NOT_FOUND", "message": "Resource not found" } } }
```

**Scenario 4 — the addition from review: releasing a STALE holdId whose seat was, in between,
lazily reclaimed under a brand-new hold.** Hold A's `expires_at` is forced into the past directly
in Postgres (simulating a TTL lapse without waiting); user B then calls the REAL `POST /holds` →
`createHold()` → `acquireSeats()` path, which genuinely reclaims the seat under a new hold B
(`createB_status: 201`). Only *then* is A released:

```json
{
  "createA_status": 201,
  "createB_status": 201,
  "delA": { "status": 200, "body": { "success": true, "data": { "released": 0 } } },
  "seatStateBeforeStaleRelease": { "state": "HELD", "hold_id": "7c7d851d-...", "held_by_user_id": "b5a13742-..." },
  "seatStateAfter":               { "state": "HELD", "hold_id": "7c7d851d-...", "held_by_user_id": "b5a13742-..." },
  "holdA": { "before": { "status": "ACTIVE" }, "after": { "status": "RELEASED" } },
  "holdB": { "before": { "status": "ACTIVE" }, "after": { "status": "ACTIVE" } }
}
```

Four things proven at once: **(a)** `delA` returns `released: 0` — `releaseHoldSeats()`'s
`hold_id = $1` predicate correctly finds nothing, since the seat's `hold_id` is now B's, not A's.
**(b)** `seatStateAfter` is byte-for-byte identical to `seatStateBeforeStaleRelease` — B's seat
was never touched. **(c)** hold A's own `seat_holds` row still correctly transitions
`ACTIVE → RELEASED` — accurate bookkeeping, since A's hold genuinely is over, just not by an
explicit release. **(d)** **hold B's `seat_holds` row is `ACTIVE` both before and after** — the
assertion requested in review. `markSeatHoldReleased(A, ...)` is keyed on `id = $1` (hold A's own
primary key), never on which seat A used to govern, so it is structurally incapable of touching
B's row. Had either predicate instead been written as a join through the *current* seat rather
than the hold's own identity, this scenario is exactly where that bug would surface: B's row
silently flipped to `RELEASED` while its seat sat there still genuinely held.

### P3-9 — the permanent Vitest/Supertest harness, and the concurrency proof suite

Everything from P0-4 through P3-4 above was proven live with throwaway scripts because no
Vitest-DB harness existed yet (Decisions Ledger D-34). This task builds that harness for real and
uses it to make the headline concurrency proofs permanent, automated regression tests instead of
one-off transcripts.

**Two Vitest configs, not one** (`server/vitest.unit.config.js`, `server/vitest.e2e.config.js`):
the unit suite (`tests/unit/**`) has no shared state and runs fully parallel; the e2e suite
(`tests/e2e/**`) shares one real `ticket_booking_test` database across every file and truncates it
between tests, so `vitest.e2e.config.js` sets `fileParallelism: false` — two files truncating the
same tables concurrently would corrupt each other's fixtures.

**`tests/setup/testEnv.js`**, loaded via the e2e config's `setupFiles`, rewrites
`process.env.DATABASE_URL` to the `_test` variant *before* any test file's own imports reach
`src/db/pool.js`. It checks whether the database name already ends in `_test` before appending —
CI's Postgres service container is already named `ticket_booking_test`
(`.github/workflows/ci.yml`), so appending unconditionally would derive
`ticket_booking_test_test`, a database that doesn't exist.

**`tests/setup/testDb.js`** provides `migrateTestDb()`, `truncateAllTables()`, and
`closeTestDb()`. Both of the first two call `assertTestDatabase()` first — a live
`SELECT current_database()` check that refuses to run unless the name ends in `_test`, a
DB-level backstop beyond `testEnv.js`'s own string derivation, since `truncateAllTables()` is the
single most destructive statement in the whole suite.

**`tests/setup/fixtures.js`** drives the real HTTP sequence (venue → category → seats → event →
show → publish) so `buildBookableShow()` gives every e2e test a ready-to-book show in one call.

**Local run, real `ticket_booking_test` database, no dev server or Vite running at the same
time** (per this file's own "stop the dev server first" rule):

```
> npm run test:unit
 Test Files  1 passed (1)
      Tests  31 passed (31)

> npm run test:e2e
 Test Files  2 passed (2)
      Tests  4 passed (4)
```

`tests/e2e/concurrency.test.js` covers the three of §6.6's six scenarios buildable through P3-4
(no bookings or waitlist/offers module exists yet — the other three move to Phase 4/5, see
`docs/PROJECT_PROMPT.md` §6.6's updated table and the Phase 3 debt note in `docs/BUILD_LOG.md`):

- 50 parallel `POST /holds` for one seat → exactly one `201`, 49 `409`s, exactly one `HELD` row
- The overlapping `{A1,A2}` vs `{A2,A3}` race → one full winner, the loser's `seat_holds` row
  count is genuinely zero (not just its HTTP response), and the final seat states are always
  exactly one of the two valid configurations
- A public `POST /holds` against an `OFFER_RESERVED` seat whose current `expires_at` has lapsed
  but whose `reserved_until` has not (D-14) → `409`, the seat completely untouched

`tests/e2e/holdExpiry.test.js` re-proves P2-7's lazy-expiry claim as a permanent test, still with
zero schedulers of any kind running (Layers 2/3 remain deferred): a `HELD` seat manually rewound
past its `expires_at` still reads `AVAILABLE` on `GET /shows/:id/seatmap`, while the raw stored row
stays `HELD` — the read computed the truth, it didn't write it.

**Falsified live before being trusted**, the same convention as P3-1's `SEAT_TRANSITIONS` proof:
`holds.queries.js#acquireSeats`'s state predicate was temporarily stripped down to
`WHERE s.id = c.id` (every OR branch removed) and `npm run test:concurrency` re-run:

```
 FAIL  tests/e2e/concurrency.test.js (3 tests | 3 failed)
   × exactly one 201, the rest 409, and the DB agrees
     expected [ …(50) ] to have a length of 1 but got 50
   × {A1,A2} vs {A2,A3} racing on A2 -> one full winner, the other holds zero seats
     expected [ …(2) ] to have a length of 1 but got 2
   × reserved_until in the future keeps the seat unacquirable even past expires_at
     expected 201 to be 409
```

All three failed for the expected reason — every racer won the 50-way race, both sides of the
overlapping-set race won, and the `OFFER_RESERVED` seat was handed straight out. The predicate was
then restored and `git status` confirmed the file byte-for-byte unchanged before this suite was
considered done — the same discipline the project applies everywhere it claims a mechanism is
proven, not merely present.

**`npm run test:concurrency`, run 3 times in a row** (matching what CI's own loop does — see
`docs/BUILD_LOG.md`'s Phase 3 debt note on flaky-concurrency risk):

```
--- run 1 ---  Test Files  1 passed (1)  Tests  3 passed (3)
--- run 2 ---  Test Files  1 passed (1)  Tests  3 passed (3)
--- run 3 ---  Test Files  1 passed (1)  Tests  3 passed (3)
```

`npm run lint` clean throughout.
