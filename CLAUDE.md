# Ticket Booking System — Project Memory

Ticket booking platform for movies and concerts. Graded submission. The score lives in three
mechanisms: **seat hold TTL**, **concurrency protection**, **waitlist time-limited offers**.

## Environment — already set up, do not redo

PostgreSQL 16.3 running as a Windows service · databases `ticket_booking` and `ticket_booking_test`
created · Node 22.19 · Git 2.51 · Claude Code via the VS Code extension.

`DATABASE_URL=postgresql://postgres:<password>@localhost:5432/ticket_booking`

Do not write install steps for these into task work — only into `docs/DEPLOYMENT.md`, so a grader
can reproduce the environment.

## Spec of record

- Full brief: @docs/PROJECT_PROMPT.md
- File-by-file map: @docs/FILE_MANIFEST.md
- Task ledger: @docs/BUILD_LOG.md

`PROJECT_PROMPT.md` is authoritative. If my instructions in chat conflict with it, stop and ask.

## Stack — do not substitute

Plain **JavaScript**, ESM (`"type": "module"`), Node 20+. **No TypeScript. No ORM.**

- npm workspaces: `server/`, `shared/`. `client/` is a plain static directory, not an npm
  workspace — see below, and Decisions Ledger D-53.
- **Server:** Express 5 · PostgreSQL via `pg` (raw SQL) · `node-pg-migrate` · `node-cron` ·
  Socket.IO · Zod · `jsonwebtoken` + `argon2` · Nodemailer + EJS · `qrcode` · `pino` ·
  `swagger-jsdoc`
- **Client (2026-08-24, D-53 — dropped the original plan, not deferred):** one static
  `client/index.html`, vanilla JS, no framework, no bundler, no build step. Served by the Express
  server itself (`express.static`) at `/` — no separate dev server, no separate deploy target.
  The original Phase 7 plan (React 18 · Vite · React Router 6 · TanStack Query · Zustand ·
  Tailwind + Headless UI · lucide-react · Recharts) will not be built. Framework choice was never
  the scored line item — the seat map working, live, is.
- **Tests:** Vitest · Supertest · a real local `ticket_booking_test` database

### Hard constraints — never work around these

My machine is **Windows, 4 GB RAM, no Docker**. This is a limit, not a preference.

- **No Docker, no containers, no `docker-compose.yml`, no `testcontainers`.** Never suggest them,
  not even as an optional path. (CI on GitHub's Linux runners may use a Postgres service container —
  that never touches my machine.)
- **No Redis, no BullMQ, no second datastore.** PostgreSQL is the only service installed.
  - Delayed jobs → `job_queue` table claimed with `FOR UPDATE SKIP LOCKED`
  - Push notification → `pg_notify()` inside the transaction + one `LISTEN` client
  - Queue position → `ROW_NUMBER() OVER (ORDER BY enqueued_at)`
  - Distributed lock → not needed; the `FOR UPDATE` row lock is the correctness boundary
  - Idempotency → the `bookings.idempotency_key` unique constraint
- Never assume the dev server, tests and a browser can run at once. Separate scripts.
- `pg.Pool` max **10**. Seed venues at ~200 seats, not 2,000.
- If a library needs a build step, a container, or more than ~200 MB, propose an alternative first.

This is framed in the docs as a deliberate architectural choice, and it is one — see PROJECT_PROMPT
§3.2. Do not describe it as a limitation or a workaround anywhere in the code, comments, or README.

I know React and Express well. I do **not** know distributed-systems patterns — explain those.

## Working rules

1. Read `docs/BUILD_LOG.md` before starting. Work only on tasks that exist there, in ID order.
2. State a plan before writing code for any task in Phase 3, 4 or 5. Use plan mode.
3. After every task: flip its status in `BUILD_LOG.md`, fill in "Files touched", "Verified by" and
   the commit hash, and update `FILE_MANIFEST.md` if files changed. Same commit as the code.
4. Non-obvious choices go in the Decisions Ledger in `BUILD_LOG.md`, not in code comments.
5. No `TODO` comments in committed code. Unfinished work is a build-log row.
6. Every mechanism gets a test that fails if the mechanism is removed.
7. One task per commit. Conventional Commits with the task ID: `feat(holds): atomic acquire [P3-2]`.
8. **Commit and push after every completed task.** See Git workflow below.
9. **Explain the code as you write it.** See Commenting standard below. I am learning this codebase,
   not just shipping it — if I can't follow the reasoning, the code isn't done.

## Git workflow — not optional

At the end of **every** task, before reporting back:

```bash
npm run lint && npm test        # never push red
git add -A                      # code AND docs together
git commit -m "feat(holds): atomic seat acquire via FOR UPDATE CTE [P3-2]"
git push origin <branch>
```

- Branch per phase: `phase/3-holds-concurrency`. Merge to `main` after `/close-phase` returns CLEAR,
  then tag: `git tag v0.3.0-phase3 && git push --tags`.
- If the push fails (no remote, auth, rejected), **tell me immediately** — do not silently continue
  working on top of unpushed commits.
- Never `git push --force` to `main`. Never commit `.env`, `node_modules`, `dist`.
- Tasks past ~40 minutes or ~8 files get an intermediate `wip:` push at the halfway mark.
- Report the commit hash and message after every push.

Rule of thumb: **if it works and it's tested, it's pushed.**

## Commenting standard — I need to understand this

There is no compiler here, so comments and JSDoc are the only documentation. Write for someone
fluent in JavaScript who has never seen a seat-hold system.

**Every file** opens with a header block: what it owns, what it deliberately does *not* own, who it
collaborates with, and any invariant it upholds.

```js
/**
 * holds.queries.js
 *
 * Owns the raw SQL for seat acquisition and release. Its own file because this SQL is the
 * single most important thing in the codebase — it deserves to be read in isolation.
 *
 * Does NOT own: hold orchestration or socket broadcasting (holds.service.js).
 *
 * Invariant: acquireSeats() is all-or-nothing — every requested seat, or none.
 */
```

**Every exported function** gets JSDoc with `@param`, `@returns`, `@throws`, and any concurrency
assumption the caller must respect. In plain JS this is also the type safety — `jsconfig.json` has
`checkJs: true`, so good JSDoc gives real editor errors.

**Explain the WHY at every non-obvious line.** I can read that a line sets `expires_at`. I cannot
read *why* it's in the `WHERE` clause instead of a cron job.

```js
// WHY this predicate rather than a scheduled job:
// A hold is expired the moment the clock passes expires_at. Putting the check here makes
// expiry a property of the data, not of a worker being alive. If every background process
// dies, seats still free themselves — the reconciler only materialises and broadcasts
// what is already logically true.
```

**The four hard mechanisms get a numbered walkthrough comment** above the function, including what
the loser of a race experiences: `holds.queries.js#acquireSeats`, `holds.service.js#releaseHold`,
`bookings.service.js#confirmBooking`, `offers.service.js#cascadeOffer`.

**Comment the trade-off, not just the choice.** `// WHY no distributed lock here: the FOR UPDATE`
`// row lock below is already the correctness boundary. A lock in a second datastore could`
`// only agree with it or be wrong.`

Also: every index comment names the query it serves; every `.env.example` var says what it controls
and what breaks if it's wrong; every error code says when it's thrown and what the UI should do.

Not wanted: comments restating the line below, JSDoc echoing parameter names, or `TODO`.

## Invariants — never violate

- A hold is expired when `expires_at <= now()` **in the SQL predicate**. Schedulers materialise and
  broadcast; they never decide. Correctness must survive every worker being dead.
- The atomic seat acquire stays **one SQL statement** (`FOR UPDATE` CTE ordered by `seat_id`).
  Never split it into read-then-write.
- **Every query function takes a `client` parameter.** Never call `pool.query` inside a transaction —
  you get a different connection and silently escape the transaction. This is the #1 way to break
  correctness with `pg`.
- `withTransaction` always releases the client in `finally`. A leaked client exhausts the pool.
- Holds are all-or-nothing. Partial success means rollback and 409.
- `releaseHold()` is idempotent. Double release is a no-op, never a throw.
- The `FOR UPDATE` row lock is the correctness boundary. Nothing else is, and nothing else needs to be.
- Cancelled seats go to `OFFER_RESERVED`, never back to the public pool during an offer window.
- Every state change routes through `seatState.machine.js`.
- Emails go through `outbox_events`, written in the same transaction as the booking.
- Jobs are enqueued **inside the caller's transaction** — a hold can never exist without its
  expiry job.
- Services never call `io.emit` directly. They call `pg_notify` inside the transaction; the
  `LISTEN` client drives the socket. This is why a rolled-back transaction can never broadcast.
- `now()` always comes from Postgres, never the app clock.

## Conventions

- ESM `import`/`export` only. No `require`.
- Error codes live in `shared/errors.js`. Never inline an error string.
- Socket event names come from `shared/socketEvents.js`. Never a raw string.
- Seat states and legal transitions come from `shared/seatStates.js` — imported by both server
  and client so the UI colours and the server guard can't drift.
- SQL lives in `*.queries.js`, never in a service or controller.
- All config via env, validated with Zod at boot. No magic numbers in code.
- Money in integer cents. Times in UTC, `timestamptz` columns.
- snake_case in SQL, camelCase in JS. Map at the query-file boundary, nowhere else.

## Commands

- Dev: `npm run dev:server` — one process serves both the API and the static client
  (`client/index.html`) at `/`. There is no separate `dev:client` anymore (D-53).
- Lint: `npm run lint` · Tests: `npm test` · Race suite: `npm run test:concurrency`
- Migrate: `npm run db:migrate` · Seed: `npm run db:seed`
- Postgres must be running (Windows service). No other service to start.

## Environment — Windows

I am on **Windows**. Assume a POSIX shell (Git Bash) unless I say otherwise, but keep every
command portable:

- **Never chain with `&&` in a shell command you tell me to run.** Windows PowerShell 5.1 rejects
  it. Put each command on its own line.
- Inside `package.json` scripts, `&&` is fine — npm runs those through `cmd.exe`.
- Prefer cross-platform npm packages over shell built-ins in scripts: `rimraf` not `rm -rf`,
  `cross-env` not `VAR=x cmd`, `npm-run-all` not `a && b`.
- No shell-specific syntax in npm scripts: no `$(...)`, no single-quoted args, no `export`.
- Paths in code use `path.join()` and `import.meta.url` → `fileURLToPath`. Never hardcode `/`.
- Line endings are enforced to LF by `.gitattributes`. If a `.sh` or `.sql` file misbehaves,
  check for CRLF first.
- Tests run against the local `ticket_booking_test` database. **Stop the dev server first** — 4 GB does
  not stretch to both. Say so in `docs/TESTING.md`.
- Postgres runs as a Windows service. If a connection fails, check `services.msc` before debugging
  connection strings.

## Priority

If time runs short, cut screens — never cut Phase 3, 4 or 5.