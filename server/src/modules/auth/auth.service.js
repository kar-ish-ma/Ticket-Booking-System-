/**
 * auth.service.js
 *
 * Owns registration, login, refresh-token rotation with reuse detection, and logout — the
 * business logic layer. auth.controller.js only translates HTTP <-> these functions;
 * auth.queries.js only runs SQL.
 *
 * Does NOT own: HTTP concerns (cookies, status codes — auth.controller.js) or the SQL itself.
 *
 * ---
 * WALKTHROUGH: refreshTokens(), and what a stolen-and-replayed token experiences
 *
 * 1. A client presents the refresh token from its httpOnly cookie. Its JWT signature is
 *    verified against JWT_REFRESH_SECRET first — a forged or tampered token is rejected before
 *    the database is even touched.
 * 2. The raw token is hashed (sha256) and looked up in refresh_tokens by that hash.
 * 3. Not found at all -> RefreshInvalidError. Doesn't happen for a token this server issued and
 *    that still exists in the DB, but covers a token surviving past its row being deleted, or
 *    one whose user no longer exists.
 * 4. Found, but revoked_at is already set -> REUSE DETECTED. The only way a client presents an
 *    already-revoked token is if two parties hold the same one: the legitimate client (which
 *    already rotated to a new token) and an attacker holding the stolen old one. The server
 *    can't tell which caller is which, so it revokes the ENTIRE family — every token descended
 *    from the original login — and returns RefreshInvalidError. Both parties are now logged
 *    out. The legitimate user has to log in again, which is a far better outcome than an
 *    attacker holding a still-valid session indefinitely.
 * 5. Found, not revoked, but expires_at has passed -> RefreshInvalidError. A stale token that
 *    was never reused; no reuse-detection response needed, just "please log in again."
 * 6. Found, not revoked, not expired -> this IS the legitimate, current token. Mark it revoked
 *    (it's being consumed right now) and insert a new row in the SAME family_id with a fresh
 *    hash and expiry — both inside one transaction, so a crash between "revoke old" and "insert
 *    new" can never leave the family with zero valid tokens while also not registering as
 *    reuse. New access and refresh JWTs are issued.
 */

import crypto from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/withTransaction.js';
import { env } from '../../config/env.js';
import { InvalidCredentialsError, EmailTakenError, RefreshInvalidError } from '../../utils/errors.js';
import * as authQueries from './auth.queries.js';

// WHY registration can't grant ADMIN, and only grants ORGANISER if the caller asked for it:
// A public POST /auth/register that accepted an arbitrary `role` field verbatim would let
// anyone become an admin by sending {"role":"ADMIN"}. shared/schemas/auth.schema.js only
// constrains which strings are syntactically valid; this function is the actual authorization
// decision, kept out of the schema so the same schema can later serve an admin-only endpoint
// that DOES need to grant arbitrary roles.
function resolveRegistrationRole(requestedRole) {
  return requestedRole === 'ORGANISER' ? 'ORGANISER' : 'CUSTOMER';
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

function signRefreshToken(userId, familyId) {
  // WHY an explicit jti (random, not derived from timing): jsonwebtoken's `iat` claim has
  // 1-second resolution. Two refresh tokens issued for the same user within the same wall-clock
  // second — plausible under real concurrency, and trivially true for two synchronous calls in
  // a test — would otherwise be byte-for-byte identical JWTs, hashing to the same token_hash and
  // crashing on the table's UNIQUE constraint instead of just being two distinct sessions.
  // Discovered live running the reuse-detection proof: register() and the immediately-following
  // refreshTokens() landed in the same second and collided.
  return jwt.sign({ sub: userId, familyId, jti: crypto.randomUUID() }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  });
}

async function issueTokenPair(client, user, familyId) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user.id, familyId);

  // WHY decode the just-signed token instead of computing the expiry separately:
  // jsonwebtoken's `expiresIn` already did the "now + duration" arithmetic once, correctly,
  // against the duration-string format env.js validated at boot. Recomputing it a second way
  // here is exactly the kind of place two computations of "the same" value quietly drift apart.
  const { exp } = jwt.decode(refreshToken);

  await authQueries.insertRefreshToken(client, {
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(exp * 1000),
  });

  return { accessToken, refreshToken };
}

/**
 * @param {{ email: string, password: string, name: string, phone?: string, role?: string }} input
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 * @throws {EmailTakenError} if the email is already registered
 */
export async function registerUser({ email, password, name, phone, role }) {
  // WHY argon2.hash runs OUTSIDE withTransaction:
  // Hashing is CPU-bound and holds no DB row locks. Running it before the transaction starts
  // keeps the transaction's own lifetime — and the row locks it may eventually take — as short
  // as possible; there's no correctness reason for a checked-out client to sit idle while argon2
  // does its (deliberately slow) work.
  const passwordHash = await argon2.hash(password);
  const resolvedRole = resolveRegistrationRole(role);

  return withTransaction(async (client) => {
    const existing = await authQueries.findUserByEmail(client, email);
    if (existing) {
      throw new EmailTakenError();
    }

    const user = await authQueries.insertUser(client, {
      email,
      passwordHash,
      name,
      phone,
      role: resolvedRole,
    });

    const familyId = crypto.randomUUID();
    const tokens = await issueTokenPair(client, user, familyId);

    return { user: toPublicUser(user), ...tokens };
  });
}

/**
 * @param {{ email: string, password: string }} input
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 * @throws {InvalidCredentialsError} on a wrong email or password — deliberately indistinguishable
 */
export async function loginUser({ email, password }) {
  return withTransaction(async (client) => {
    const user = await authQueries.findUserByEmail(client, email);
    if (!user) {
      throw new InvalidCredentialsError();
    }

    const passwordValid = await argon2.verify(user.passwordHash, password);
    if (!passwordValid) {
      throw new InvalidCredentialsError();
    }

    const familyId = crypto.randomUUID();
    const tokens = await issueTokenPair(client, user, familyId);

    return { user: toPublicUser(user), ...tokens };
  });
}

/**
 * See the file header's walkthrough for the full six-branch decision tree, including what a
 * stolen-and-replayed token experiences.
 *
 * @param {string | undefined} rawRefreshToken
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 * @throws {RefreshInvalidError} on any invalid, expired, unknown, or reused token
 */
export async function refreshTokens(rawRefreshToken) {
  if (!rawRefreshToken) {
    throw new RefreshInvalidError('No refresh token provided');
  }

  try {
    jwt.verify(rawRefreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    throw new RefreshInvalidError();
  }

  const tokenHash = hashToken(rawRefreshToken);

  // WHY this returns an { outcome, ... } object from inside the transaction and only decides
  // whether to throw AFTER it commits, instead of throwing RefreshInvalidError directly inside
  // the reuse-detected branch: withTransaction() rolls back on ANY thrown error, unconditionally
  // (that's the whole point of it — see its own header). Throwing from inside this transaction
  // to report "reuse detected" would roll back the revokeRefreshTokenFamily call two lines
  // above it in the SAME transaction, silently undoing the one thing that branch exists to do.
  // Found live running the reuse-detection proof: the family "revocation" was never actually
  // persisted, so the very next call with the supposedly-revoked token succeeded normally.
  const result = await withTransaction(async (client) => {
    const tokenRow = await authQueries.findRefreshTokenByHash(client, tokenHash);

    if (!tokenRow) {
      return { outcome: 'invalid' };
    }

    if (tokenRow.revokedAt) {
      // Reuse detected — see the file header's step 4. This branch returns normally so the
      // revocation commits; see the WHY comment above for why throwing here would undo it.
      await authQueries.revokeRefreshTokenFamily(client, tokenRow.familyId);
      return { outcome: 'reuse' };
    }

    // WHY tokenRow.isExpired (computed in SQL by findRefreshTokenByHash) instead of comparing
    // tokenRow.expiresAt against `new Date()` here: now() always comes from Postgres, never the
    // app clock (CLAUDE.md) — an app-clock comparison would be wrong under clock skew between
    // this process and the database in exactly the way that invariant exists to prevent. See
    // Decisions Ledger D-29.
    if (tokenRow.isExpired) {
      return { outcome: 'expired' };
    }

    const user = await authQueries.findUserById(client, tokenRow.userId);
    if (!user) {
      return { outcome: 'invalid' };
    }

    await authQueries.revokeRefreshToken(client, tokenHash);
    const tokens = await issueTokenPair(client, user, tokenRow.familyId);

    return { outcome: 'success', user: toPublicUser(user), ...tokens };
  });

  if (result.outcome === 'reuse') {
    throw new RefreshInvalidError('Refresh token reuse detected; all sessions revoked');
  }
  if (result.outcome === 'expired') {
    throw new RefreshInvalidError('Refresh token expired');
  }
  if (result.outcome === 'invalid') {
    throw new RefreshInvalidError();
  }

  return result;
}

/**
 * Idempotent: logging out with no cookie, or one already revoked, is a no-op.
 *
 * @param {string | undefined} rawRefreshToken
 * @returns {Promise<void>}
 */
export async function logoutUser(rawRefreshToken) {
  if (!rawRefreshToken) return;

  const tokenHash = hashToken(rawRefreshToken);
  await withTransaction(async (client) => {
    await authQueries.revokeRefreshToken(client, tokenHash);
  });
}

/**
 * WHY `pool` directly, not `withTransaction`: a single read with no follow-up write needs no
 * transaction at all — see withTransaction.js's header for the distinction ("pool.query()
 * directly (outside a transaction) or a client ... inside withTransaction()").
 *
 * @param {string} userId
 * @returns {Promise<object | null>} the public user shape, or null if the user no longer exists
 */
export async function getUserById(userId) {
  const user = await authQueries.findUserById(pool, userId);
  return user ? toPublicUser(user) : null;
}
