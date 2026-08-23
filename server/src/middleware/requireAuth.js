/**
 * requireAuth.js
 *
 * Owns verifying the access-token cookie and attaching req.user = { id, role }. Every route
 * that isn't public goes through this first.
 *
 * Does NOT own role or ownership checks — requireRole.js and requireOwnership.js, chained after
 * this, do. Splitting them keeps "are you logged in" and "are you allowed to do THIS specific
 * thing" as two separate, independently testable questions, matching
 * docs/PROJECT_PROMPT.md §4.1's explicit framing that role and ownership are different checks.
 */

import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { UnauthenticatedError } from '../utils/errors.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.accessToken;
  if (!token) {
    next(new UnauthenticatedError('No access token'));
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new UnauthenticatedError('Invalid or expired access token'));
  }
}
