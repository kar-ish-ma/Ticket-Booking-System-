/**
 * requireRole.js
 *
 * Owns RBAC: does req.user (attached by requireAuth, which must run first) have one of the
 * allowed roles.
 *
 * Does NOT own ownership — requireOwnership.js. Passing requireRole('ORGANISER') proves the
 * caller IS an organiser, not that they own the specific event or show they're about to touch.
 */

import { ForbiddenError } from '../utils/errors.js';

/**
 * @param {...string} allowedRoles
 * @returns {import('express').RequestHandler}
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}
