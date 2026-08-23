-- 001_init.sql
--
-- Owns: every enum type the schema uses (created up front so later migrations can just
-- reference them), plus the four tables with no dependency on anything else -- users, venues,
-- seat_categories, seats. This is the foundation every other migration builds on.
--
-- Reversible: yes. Down drops the four tables (child-to-parent order) then every enum.

-- Up Migration

CREATE TYPE role_t           AS ENUM ('ADMIN', 'ORGANISER', 'CUSTOMER');
CREATE TYPE event_type_t     AS ENUM ('MOVIE', 'CONCERT');
CREATE TYPE show_status_t    AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');
CREATE TYPE seat_state_t     AS ENUM ('AVAILABLE', 'HELD', 'OFFER_RESERVED', 'BOOKED', 'BLOCKED');
CREATE TYPE hold_status_t    AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED');
CREATE TYPE booking_status_t AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');
CREATE TYPE waitlist_status_t AS ENUM ('WAITING', 'OFFERED', 'CONVERTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE offer_status_t   AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'SUPERSEDED');
CREATE TYPE outbox_status_t  AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  phone         text,
  role          role_t NOT NULL DEFAULT 'CUSTOMER',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text NOT NULL,
  city        text NOT NULL,
  layout_meta jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- serves: GET /events browse filtered/joined by city
CREATE INDEX idx_venues_city ON venues (city);

CREATE TABLE seat_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  name       text NOT NULL,
  color_hex  text NOT NULL DEFAULT '#6366f1',
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (venue_id, name)
);

CREATE TABLE seats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES seat_categories (id),
  row_label     text NOT NULL,
  seat_number   int NOT NULL,
  grid_row      int NOT NULL,
  grid_col      int NOT NULL,
  is_accessible boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (venue_id, row_label, seat_number),
  -- WHY this second UNIQUE constraint: no two seats may render in the same grid cell. The
  -- (row_label, seat_number) pair is the human-facing identity; this one guards the physical
  -- layout, which is a separate invariant a bad admin edit could violate independently.
  UNIQUE (venue_id, grid_row, grid_col)
);

-- Down Migration

DROP TABLE seats;
DROP TABLE seat_categories;
DROP TABLE venues;
DROP TABLE users;

DROP TYPE outbox_status_t;
DROP TYPE offer_status_t;
DROP TYPE waitlist_status_t;
DROP TYPE booking_status_t;
DROP TYPE hold_status_t;
DROP TYPE seat_state_t;
DROP TYPE show_status_t;
DROP TYPE event_type_t;
DROP TYPE role_t;
