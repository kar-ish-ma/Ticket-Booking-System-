-- 004_bookings.sql
--
-- Owns: bookings, the deferred show_seats.booking_id foreign key (see 003's header),
-- booking_seats, and payments.
--
-- Deliberate two-way link -- be ready to defend this in review:
--   show_seats.booking_id = the CURRENT occupant, read on every seat-map render.
--   booking_seats         = the historical record, and the only place the price actually
--                            charged is stored. Prices change; a cancelled booking must still
--                            show what the customer paid. On cancellation, show_seats.booking_id
--                            is cleared but booking_seats is kept.
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text UNIQUE NOT NULL,
  show_id         uuid NOT NULL REFERENCES shows (id),
  user_id         uuid NOT NULL REFERENCES users (id),
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
-- serves: GET /bookings, a user's own booking history newest-first
CREATE INDEX idx_bookings_user ON bookings (user_id, created_at DESC);

-- See 003_show_seats.sql's header: this constraint couldn't be declared inline because
-- bookings didn't exist yet when show_seats was created.
ALTER TABLE show_seats
  ADD CONSTRAINT show_seats_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings (id);

CREATE TABLE booking_seats (
  booking_id   uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  show_seat_id uuid NOT NULL REFERENCES show_seats (id),
  price_cents  int NOT NULL,
  PRIMARY KEY (booking_id, show_seat_id)
);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid UNIQUE NOT NULL REFERENCES bookings (id),
  provider     text NOT NULL DEFAULT 'MOCK',
  status       text NOT NULL,
  amount_cents int NOT NULL,
  txn_ref      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE payments;
DROP TABLE booking_seats;
ALTER TABLE show_seats DROP CONSTRAINT show_seats_booking_id_fkey;
DROP TABLE bookings;
