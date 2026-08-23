-- 007_job_queue.sql
--
-- Owns: job_queue -- the BullMQ replacement (docs/PROJECT_PROMPT.md §3.3). A delayed job is a
-- row; claiming it is a single UPDATE ... FOR UPDATE SKIP LOCKED, the same primitive the
-- waitlist cascade uses. One idea to explain instead of two.
--
-- WHY `status` is plain text with a comment, not an enum like every other status column in this
-- schema: matches the type used everywhere job_queue is referenced elsewhere in the spec
-- (docs/PROJECT_PROMPT.md §3.3's own CREATE TABLE). Kept consistent rather than "improved" to an
-- enum, since the poller and its handlers are Phase 1/3/4/5 code that will be written against
-- this exact shape.
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE job_queue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,       -- HOLD_EXPIRY | OFFER_EXPIRY | OUTBOX_SEND
  payload    jsonb NOT NULL,
  run_at     timestamptz NOT NULL, -- delayed execution: not claimable until now() >= run_at
  status     text NOT NULL DEFAULT 'PENDING', -- PENDING|RUNNING|DONE|FAILED|DEAD
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: the poller's claim query (queue/poller.js), which runs every JOB_POLL_INTERVAL_MS.
-- Partial index (WHERE status = 'PENDING') since RUNNING/DONE/FAILED/DEAD rows are never
-- claimable and would just be dead weight in the index.
CREATE INDEX idx_job_queue_claim ON job_queue (status, run_at) WHERE status = 'PENDING';

-- Down Migration

DROP TABLE job_queue;
