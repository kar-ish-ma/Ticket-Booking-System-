-- 006_outbox_audit.sql
--
-- Owns: outbox_events (the transactional email outbox -- a booking and its email commit
-- together or not at all), ticket_scans (the check-in audit trail), and audit_log (every other
-- state-changing action).
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       outbox_status_t NOT NULL DEFAULT 'PENDING',
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- serves: the OUTBOX_SEND job handler's drain query
CREATE INDEX idx_outbox_drain ON outbox_events (status, available_at);

CREATE TABLE ticket_scans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id),
  result     text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_by uuid REFERENCES users (id)
);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES users (id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: looking up every audit row for one entity (e.g. one booking's full history)
CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id);

-- Down Migration

DROP TABLE audit_log;
DROP TABLE ticket_scans;
DROP TABLE outbox_events;
