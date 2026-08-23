-- 003_show_seats.sql
--
-- Owns: seat_holds and show_seats -- THE critical table. One row per seat per show; the row IS
-- the lock the atomic acquire (holds.queries.js, Phase 3) takes with FOR UPDATE.
--
-- WHY show_seats.booking_id has no REFERENCES clause here, unlike every other FK in this file:
-- bookings doesn't exist until 004_bookings.sql. docs/FILE_MANIFEST.md groups show_seats into
-- this migration and bookings into the next one, which makes the dependency point the "wrong"
-- way for a single CREATE TABLE statement. Rather than fight that grouping or duplicate the
-- table definition across migrations, booking_id is created as a plain uuid column here and
-- 004 adds the FK constraint with ALTER TABLE once bookings exists. Referential integrity is
-- enforced from the moment bookings exists — there is no window where a bad booking_id could be
-- written and then grandfathered in, because nothing in this codebase writes to show_seats until
-- Phase 2 at the earliest, long after 004 has run.
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE seat_holds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id    uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id),
  status     hold_status_t NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: the Layer-3 reconciler's sweep of expired-but-still-ACTIVE holds
CREATE INDEX idx_holds_sweep ON seat_holds (status, expires_at);

CREATE TABLE show_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id         uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  seat_id         uuid NOT NULL REFERENCES seats (id),
  category_id     uuid NOT NULL REFERENCES seat_categories (id),
  state           seat_state_t NOT NULL DEFAULT 'AVAILABLE',
  hold_id         uuid REFERENCES seat_holds (id),
  held_by_user_id uuid REFERENCES users (id),
  -- HELD: hold TTL. OFFER_RESERVED: current cascade attempt's deadline, extended on each
  -- cascade attempt.
  expires_at      timestamptz,
  -- OFFER_RESERVED only. Fixed end of the whole cascade window, set once on entry, never
  -- extended. The acquire predicate (holds.queries.js, Phase 3) checks THIS for OFFER_RESERVED,
  -- not expires_at, so a public hold can never win a seat while a cascade could still be live.
  -- See Decisions Ledger D-14.
  reserved_until  timestamptz,
  -- No REFERENCES here -- see file header. Constraint added in 004_bookings.sql.
  booking_id      uuid,
  version         int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Makes double-allocation of one seat on one show physically impossible, independent of any
  -- application-level check.
  UNIQUE (show_id, seat_id)
);
-- serves: GET /shows/:id/seatmap rendering every seat's current state for one show
CREATE INDEX idx_show_seats_map ON show_seats (show_id, state);
-- serves: the Layer-3 hold reconciler's 30s sweep (docs/PROJECT_PROMPT.md §5.2) -- partial
-- index, since only HELD/OFFER_RESERVED rows ever carry a non-null expires_at
CREATE INDEX idx_show_seats_sweep ON show_seats (state, expires_at) WHERE expires_at IS NOT NULL;
-- serves: GET /shows/:id/availability's per-category effective-availability counts
CREATE INDEX idx_show_seats_avail ON show_seats (show_id, category_id, state);

-- Down Migration

DROP TABLE show_seats;
DROP TABLE seat_holds;
