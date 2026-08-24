# Demo script

A 5-minute walkthrough for grading this submission live, with the credentials and the one caveat
that trips people up on a first visit (the cold start).

**Live URL:** https://ticket-booking-system-dzwg.onrender.com

## Before you click anything: the cold start

This runs on Render's free tier (`render.yaml`, `docs/DEPLOYMENT.md`). If nobody has hit the URL
in the last ~15 minutes, the instance is asleep and the **first** request wakes it — that request
can take **up to ~50 seconds** before anything comes back, including `/health`. This is a hosting
platform limit, not an app bug. If the page looks like it's hanging on first load, that's what's
happening — wait it out rather than reloading. Every request after the first one is normal speed
(well under a second).

## Demo credentials

Seeded automatically on every boot (`server/src/db/seed.js`), all with the same password:

| Role | Email | Password |
|---|---|---|
| Customer | `customer@ticketbooking.test` | `Password123!` |
| Organiser | `organiser@ticketbooking.test` | `Password123!` |
| Admin | `admin@ticketbooking.test` | `Password123!` |

Two demo shows are seeded alongside the accounts — **Midnight Static** (a concert) and **The Last
Voyage** (a movie), one venue, 32 seats across two price categories. `organiser@ticketbooking.test`
owns both events, so logging in as the organiser and opening either event's "Summary" button on the
browse screen shows a live revenue/occupancy breakdown.

**Seed shows use a 120-second hold TTL, not the 600-second default** (`shows.hold_ttl_seconds`,
set in `seed.js#seedDemoCatalogue`). That's deliberate: a real customer-facing show would give
someone ten minutes to complete checkout, but a ten-minute wait is not a demo — 120 seconds is
long enough to walk through the flow below at a normal pace, short enough that you can also just
*wait it out* on screen and watch the countdown hit zero, the seat map poll pick the release up
within ~3 seconds, and the seat go back to available with nobody having touched a release button.
That's the seat-hold TTL mechanism (§5 of `docs/PROJECT_PROMPT.md`) proving itself live, not a
claim in a README.

## The 5-minute walkthrough

1. **Log in** as the customer account above.
2. **Browse** — the event list loads both seeded shows. Pick either one, pick its one showtime.
3. **Seat map** — a live grid, colour-coded by state (legend above the grid: available / selected
   / held / booked), polling `GET /shows/:id/seatmap` every 3 seconds. Click 2-3 available seats
   to select them (max 6).
4. **Hold** — "Hold selected seats." The seats flip to your own held colour immediately, and a
   countdown starts (amber under 60s, red under 15s) — this is the 120-second TTL from above.
5. **Confirm** — before the countdown runs out, click "Confirm booking." You land on a
   confirmation screen with a real booking reference and a **QR code** — the same `qrcode`-rendered
   PNG the confirmation email would carry, shown immediately rather than making you wait on email.
6. **Cancel** — click "Cancel this booking." The confirmation panel clears, the seat map is
   refetched, and the seats you just booked show as available again (or, if someone else has since
   joined the waitlist for that category, as offered to them instead — §7 of
   `docs/PROJECT_PROMPT.md`).

Optional, if you have two browser windows open: hold the same seat in both as two different logged-
in users. One gets it, the other gets a `409 SEATS_UNAVAILABLE` naming exactly which seat lost —
the concurrency guarantee (§6) from the outside, not just the `tests/e2e/concurrency.test.js` proof.

## Beyond the click-through

- **`/api/docs`** — the full live API reference (Swagger UI, generated from the route files'
  own JSDoc — nothing hand-maintained to drift out of sync).
- **`docs/TESTING.md`** — how to run the suite locally, including the concurrency proof
  (`npm run test:concurrency`) that's the actual evidence behind the claims in this walkthrough.
- **`docs/SYSTEM_DESIGN.md`** — the ≤800-word write-up on the hold TTL and concurrency mechanisms,
  for the reasoning behind what you just clicked through.
