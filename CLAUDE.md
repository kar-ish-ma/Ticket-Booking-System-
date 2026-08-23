# TicketFlow — Project Memory

Ticket booking platform for movies and concerts. Graded submission. The score lives in three
mechanisms: **seat hold TTL**, **concurrency protection**, **waitlist time-limited offers**.

## Spec of record

- Full brief: @docs/PROJECT_PROMPT.md
- File-by-file map: @docs/FILE_MANIFEST.md
- Task ledger: @docs/BUILD_LOG.md

`PROJECT_PROMPT.md` is authoritative. If my instructions in chat conflict with it, stop and ask.

## Stack — do not substitute

Plain **JavaScript**, ESM (`"type": "module"`), Node 20+. **No TypeScript. No ORM.**

- npm workspaces: `server/`, `client/`, `shared/`
- **Server:** Express 5 · PostgreSQL via `pg` (raw SQL) · `node-pg-migrate` · Redis (`ioredis`) ·
  BullMQ · `node-cron` · Socket.IO · Zod · `jsonwebtoken` + `argon2` · Nodemailer + EJS · `qrcode` ·
  `pino` · `swagger-jsdoc`
- **Client:** React 18 · Vite · React Router 6 · TanStack Query · Zustand · Tailwind + Headless UI ·
  lucide-react · Recharts
- **Tests:** Vitest · Supertest · `testcontainers` (real Postgres + Redis)

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

**Comment the trade-off, not just the choice.** `// The Redis lock sheds load before the DB; it is`
`// NOT the correctness boundary — the row lock below is.`

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
- Redis locks are a load-shedder, not the correctness boundary. The database is.
- Cancelled seats go to `OFFER_RESERVED`, never back to the public pool during an offer window.
- Every state change routes through `seatState.machine.js`.
- Emails go through `outbox_events`, written in the same transaction as the booking.
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

- Dev: `npm run dev` (server + client together)
- Lint: `npm run lint` · Tests: `npm test` · Race suite: `npm run test:concurrency`
- Migrate: `npm run db:migrate` · Seed: `npm run db:seed`
- Infra: `docker compose up -d`

## Priority

If time runs short, cut screens — never cut Phase 3, 4 or 5.
