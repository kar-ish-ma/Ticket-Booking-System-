# SYSTEM DESIGN

## 1. SEAT HOLD AND TTL MECHANISM

`show_seats` is the authority for a seat's current claim. A successful hold writes `HELD`, its owner and hold id, plus an SQL-derived `expires_at`; the parent `seat_holds` record is created in the same transaction. The seat map derives effective availability with `HELD AND expires_at <= now()` rather than rewriting the row. Acquisition uses the same rule: an expired `HELD` row is eligible for replacement by a new hold.

Lazy expiry is deliberate: a hold is expired because `expires_at <= now()` is evaluated IN THE SQL PREDICATE, not because a job ran. Correctness never depends on a scheduler being alive. This was proven with zero schedulers running before any TTL worker existed: a backdated `HELD` row stayed stored as `HELD`, while the seat map returned `AVAILABLE`; acquisition also reclaimed it. Workers and sweeps are deferred timeliness mechanisms, not correctness mechanisms.

Explicit release is idempotent. Its guarded update affects only rows still owned by that hold and still `HELD`; a stale release cannot clear a later hold. The parent is independently terminal by primary key, making delayed calls safe.

## 2. CONCURRENCY PREVENTION

`acquireSeats()` locks candidate `show_seats` rows `FOR UPDATE`, ordered by `seat_id`, then updates only currently eligible rows. READ COMMITTED is sufficient: when UPDATE blocks on a row lock, Postgres re-evaluates the WHERE clause against the newly committed row. The loser of a seat race simply fails its predicate, rowCount comes back short, the transaction rolls back, and the caller gets a clean 409. No SERIALIZABLE, no retry loop. `FOR UPDATE` ordered by `seat_id` gives deterministic lock ordering, so overlapping multi-seat requests queue instead of deadlocking.

`acquireSeats()` is deliberately NOT all-or-nothing. Both transactions take all their row locks before either predicate evaluates, so the loser of a contested seat can still win an uncontested one in the same statement. The all-or-nothing guarantee lives in the caller's shortfall check and rollback, not in the query. Documenting this wrongly would let a future maintainer skip that check and silently ship partial holds. `createHold()` creates the parent row and calls `acquireSeats()` in one transaction; any short result throws, rolling back both the acquired rows and the parent record.

The permanent CI suite ran 50 parallel holds for one seat: exactly one winner and 49 conflicts, across three consecutive runs. The overlap race also proves one full winner and zero persisted seats for the loser. Every mechanism was falsified by deleting it and confirming the relevant tests fail.

## 3. WAITLIST AUTO-ASSIGNMENT FLOW

Cancellation predicate-marks a confirmed booking `CANCELLED`, refunds it, reads its seats, and processes each category in one transaction. With no claimed waiting entry, seats transition `BOOKED` to `AVAILABLE`. Otherwise the earliest `WAITING` entry is locked, the category's cancelled seats transition `BOOKED` to `OFFER_RESERVED`, an offer row is inserted, and the entry becomes `OFFERED`.

Cancelled seats go to `OFFER_RESERVED`, never back to the public pool while an offer is live. Booking cancel, seat transition, offer insert and the waitlist entry update are ONE transaction — splitting them was tested and produced a booking marked `CANCELLED` with seats still `BOOKED`, unrecoverable by any other layer. A forced offer-insert failure verifies the booking remains `CONFIRMED` and its seat `BOOKED`.

This routing is category-specific, preserving the released inventory's price category and preventing public acquisition from racing an identified waitlister. It also uses the state-machine transition `BOOKED -> OFFER_RESERVED`; ordinary release uses `BOOKED -> AVAILABLE`. The public hold predicate treats an `OFFER_RESERVED` seat as unavailable until its outer reservation window ends. Scope was deliberately cut: automatic cascade re-offering after an offer lapses is designed but not wired.

## 4. TIME-LIMITED OFFER HANDLING

An initial offer generates a UUID-backed raw capability token and stores only its SHA-256 hash. The token identifies a pending offer and its exact reserved show-seat ids; it is sent to the offeree, never persisted in raw form. Offer presentation checks the token hash, `PENDING` status, and SQL-derived expiry. Acceptance creates the booking and payment within a transaction, then atomically updates precisely those seats from `OFFER_RESERVED` to `BOOKED` with `expires_at > now()`. A second acceptance loses that guarded update, rolls back booking and payment, and receives an invalid-offer result.

`reserved_until` bounds the entire cascade window and is set once; `expires_at` is the current offer's deadline and moves on each cascade step. The initial reservation computes the former from offer TTL, maximum attempts, and a fixed grace period, while the offer row computes the latter independently with PostgreSQL `now()`. Public acquisition must test `reserved_until`, not an offer's `expires_at`: an expired attempt is not public inventory while a legitimate cascade may continue. Only after `reserved_until <= now()` may a public hold reclaim the seat.

Cascade execution is deferred. The state machine permits `OFFER_RESERVED -> OFFER_RESERVED` for that future step without extending the fixed outer bound.

Word count: 797
