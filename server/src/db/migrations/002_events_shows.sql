-- 002_events_shows.sql
--
-- Owns: events, shows, and per-show-per-category pricing. Depends on 001_init.sql for
-- event_type_t, show_status_t, users (organiser_id) and venues.
--
-- Reversible: yes. Down drops in reverse dependency order.

-- Up Migration

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id uuid NOT NULL REFERENCES users (id),
  title        text NOT NULL,
  type         event_type_t NOT NULL,
  description  text NOT NULL DEFAULT '',
  poster_url   text,
  language     text,
  genre        text,
  duration_min int NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- serves: GET /events browse filtered by type and publish status
CREATE INDEX idx_events_browse ON events (type, is_published);

CREATE TABLE shows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  venue_id          uuid NOT NULL REFERENCES venues (id),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  status            show_status_t NOT NULL DEFAULT 'SCHEDULED',
  hold_ttl_seconds  int NOT NULL DEFAULT 600,
  offer_ttl_seconds int NOT NULL DEFAULT 900
);
-- serves: browse/listing queries ordering upcoming shows and filtering out cancelled ones
CREATE INDEX idx_shows_upcoming ON shows (starts_at, status);

CREATE TABLE show_prices (
  show_id     uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories (id),
  price_cents int NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (show_id, category_id)
);

-- Down Migration

DROP TABLE show_prices;
DROP TABLE shows;
DROP TABLE events;
