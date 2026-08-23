-- 005_waitlist.sql
--
-- Owns: waitlist_entries (the FIFO queue itself) and waitlist_offers (a time-limited claim on a
-- specific set of freed seats, offered to the head of that queue).
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE waitlist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id     uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  quantity    int NOT NULL DEFAULT 1,
  status      waitlist_status_t NOT NULL DEFAULT 'WAITING',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (show_id, category_id, user_id)
);
-- serves: the FOR UPDATE SKIP LOCKED head-of-queue select during the cancellation cascade, and
-- the ROW_NUMBER() OVER (ORDER BY enqueued_at) position lookup (docs/PROJECT_PROMPT.md §7.1)
CREATE INDEX idx_waitlist_fifo ON waitlist_entries (show_id, category_id, status, enqueued_at);

CREATE TABLE waitlist_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_entry_id uuid NOT NULL REFERENCES waitlist_entries (id),
  -- Array, so no FK enforcement on the individual seat ids -- validated in offers.service.js
  -- (Phase 5) instead. A real FK on an array column isn't expressible in Postgres.
  show_seat_ids     uuid[] NOT NULL,
  -- sha256 of the raw claim token; the raw token is never stored, only emailed once.
  token_hash        text UNIQUE NOT NULL,
  status            offer_status_t NOT NULL DEFAULT 'PENDING',
  attempt_no        int NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- serves: the offer-expiry job poller's sweep for lapsed PENDING offers to cascade
CREATE INDEX idx_offers_sweep ON waitlist_offers (status, expires_at);

-- Down Migration

DROP TABLE waitlist_offers;
DROP TABLE waitlist_entries;
