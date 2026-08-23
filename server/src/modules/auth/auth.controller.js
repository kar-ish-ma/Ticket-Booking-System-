/**
 * auth.controller.js
 *
 * Owns translating HTTP <-> auth.service.js: reading the validated body, setting/clearing the
 * httpOnly cookies, shaping the response envelope. No business logic and no SQL live here.
 *
 * Does NOT own: password hashing, token signing, or rotation logic (auth.service.js).
 */

import { env } from '../../config/env.js';
import * as authService from './auth.service.js';

const isProd = env.NODE_ENV === 'production';

// jsonwebtoken's `expiresIn` already validated these against env.js's duration-string pattern
// (\d+(s|m|h|d|w)) at boot — this only needs to parse the same shape into milliseconds for the
// cookie's own maxAge, which jsonwebtoken has no equivalent option for.
const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
function durationToMs(duration) {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(duration);
  const [, amount, unit] = match;
  return Number(amount) * DURATION_UNIT_MS[unit];
}

const ACCESS_COOKIE = 'accessToken';
const REFRESH_COOKIE = 'refreshToken';
// WHY the refresh cookie is scoped to this narrower path, unlike the access cookie's '/':
// The refresh token is the longer-lived, more sensitive of the two. Scoping its cookie so the
// browser only ever sends it to auth endpoints (not every API call) shrinks its exposure —
// httpOnly already keeps it away from JS, this keeps it away from unrelated network requests too.
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: durationToMs(env.JWT_ACCESS_TTL),
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: durationToMs(env.JWT_REFRESH_TTL),
  });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

/**
 * POST /api/v1/auth/register
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function register(req, res, next) {
  try {
    const { user, accessToken, refreshToken } = await authService.registerUser(req.body);
    setAuthCookies(res, { accessToken, refreshToken });
    res.status(201).json({ success: true, data: { user }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/auth/login
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function login(req, res, next) {
  try {
    const { user, accessToken, refreshToken } = await authService.loginUser(req.body);
    setAuthCookies(res, { accessToken, refreshToken });
    res.status(200).json({ success: true, data: { user }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/auth/refresh — reads the refresh token from its cookie, not the body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function refresh(req, res, next) {
  try {
    const { user, accessToken, refreshToken } = await authService.refreshTokens(
      req.cookies?.[REFRESH_COOKIE]
    );
    setAuthCookies(res, { accessToken, refreshToken });
    res.status(200).json({ success: true, data: { user }, error: null });
  } catch (err) {
    // WHY clear cookies even on failure:
    // A refresh that fails (expired, reused, invalid) means the client's current cookies are no
    // longer good for anything. Leaving a dead refresh cookie in the browser just means the next
    // request tries the same failing refresh again instead of prompting a clean re-login.
    clearAuthCookies(res);
    next(err);
  }
}

/**
 * POST /api/v1/auth/logout — idempotent; always succeeds, even with no active session.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function logout(req, res, next) {
  try {
    await authService.logoutUser(req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.status(200).json({ success: true, data: null, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/auth/me — requireAuth has already run; req.user is guaranteed present.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function me(req, res, next) {
  try {
    const user = await authService.getUserById(req.user.id);
    res.status(200).json({ success: true, data: { user }, error: null });
  } catch (err) {
    next(err);
  }
}
