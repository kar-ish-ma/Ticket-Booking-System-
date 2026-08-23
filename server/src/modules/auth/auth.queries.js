/**
 * auth.queries.js
 *
 * Owns the raw SQL for users and refresh_tokens, and the snake_case (SQL) <-> camelCase (JS)
 * mapping at this boundary — nowhere else in the codebase touches a raw row from these tables.
 *
 * Does NOT own: password hashing, JWT signing, or token rotation logic (auth.service.js).
 *
 * Invariant: every function here takes a `client`. Never call `pool.query` inside a
 * transaction — see withTransaction.js's header for why that silently breaks correctness.
 */

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    phone: row.phone,
    role: row.role,
    createdAt: row.created_at,
  };
}

function mapRefreshTokenRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    familyId: row.family_id,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ email: string, passwordHash: string, name: string, phone?: string, role: string }} params
 * @returns {Promise<object>} the created user, camelCased, including passwordHash
 */
export async function insertUser(client, { email, passwordHash, name, phone, role }) {
  const result = await client.query(
    `INSERT INTO users (email, password_hash, name, phone, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, password_hash, name, phone, role, created_at`,
    [email, passwordHash, name, phone ?? null, role]
  );
  return mapUserRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} email
 * @returns {Promise<object | null>}
 */
export async function findUserByEmail(client, email) {
  const result = await client.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return mapUserRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function findUserById(client, id) {
  const result = await client.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return mapUserRow(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ userId: string, tokenHash: string, familyId: string, expiresAt: Date }} params
 * @returns {Promise<void>}
 */
export async function insertRefreshToken(client, { userId, tokenHash, familyId, expiresAt }) {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, familyId, expiresAt]
  );
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} tokenHash
 * @returns {Promise<object | null>}
 */
export async function findRefreshTokenByHash(client, tokenHash) {
  const result = await client.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [
    tokenHash,
  ]);
  return mapRefreshTokenRow(result.rows[0]);
}

/**
 * Idempotent: revoking an already-revoked token is a no-op, never an error — mirrors
 * releaseHold()'s idempotency invariant (CLAUDE.md) for the same reason: multiple code paths
 * (a rotation, a reuse-detection sweep, a logout) may all try to revoke the same token.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tokenHash
 * @returns {Promise<void>}
 */
export async function revokeRefreshToken(client, tokenHash) {
  await client.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} familyId
 * @returns {Promise<void>}
 */
export async function revokeRefreshTokenFamily(client, familyId) {
  await client.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId]
  );
}
