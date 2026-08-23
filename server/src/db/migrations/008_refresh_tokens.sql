-- 008_refresh_tokens.sql
--
-- Owns: refresh_tokens -- the server-side allowlist backing refresh-token rotation and reuse
-- detection. Not part of docs/PROJECT_PROMPT.md §4.2's original schema; added here because
-- P1-5's "rotation with reuse detection" requirement cannot be met by a bare stateless JWT.
-- A JWT's signature proves it wasn't forged, but proves nothing about whether THIS specific
-- token has already been consumed -- that requires a server-side record.
--
-- Design: refresh tokens are still real JWTs (signed with JWT_REFRESH_SECRET, per the stack's
-- own "jsonwebtoken ... refresh 7d" framing) -- this table is a hash-based allowlist alongside
-- them, not a replacement for them. On every refresh, the presented token must BOTH verify
-- against JWT_REFRESH_SECRET AND have an unrevoked, unexpired row here. The DB row is what
-- actually gates rotation; the JWT signature is the first, cheaper line of defence against a
-- forged token before ever touching the database.
--
-- family_id groups every token descended from one login. Rotating replaces one row with another
-- sharing the same family_id; presenting a token whose row is already revoked means someone
-- replayed an old, already-rotated token -- the whole family gets revoked in response, forcing
-- a fresh login. A stolen-and-later-used refresh token is detectable precisely because rotation
-- makes "already used" a fact the database remembers, not just a timestamp comparison.
--
-- Reversible: yes.

-- Up Migration

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- sha256 of the raw JWT string. The raw token only ever lives in the httpOnly cookie; storing
  -- a hash means a DB read (a backup, a leaked export) can't be replayed as a live session.
  token_hash text UNIQUE NOT NULL,
  family_id  uuid NOT NULL,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- serves: revoking every token in a family at once when reuse is detected
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);

-- Down Migration

DROP TABLE refresh_tokens;
