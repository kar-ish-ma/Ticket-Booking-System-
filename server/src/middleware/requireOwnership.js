/**
 * requireOwnership.js
 *
 * Owns the check that's separate from RBAC and commonly missed: having the ORGANISER role
 * proves nothing about owning THIS event. Every route that lets an organiser modify a specific
 * resource chains this after requireRole('ORGANISER'), passing a loader that fetches the
 * resource and reports who owns it.
 *
 * No concrete resource (events, shows, ...) exists yet — those arrive in Phase 2. This is the
 * reusable middleware factory every one of those modules will wire up, built now so Phase 2
 * only has to write a one-line loader per route, not re-derive ownership-checking logic per
 * module.
 */

import { ERROR_CODES } from 'shared/errors.js';
import { DomainError, ForbiddenError } from '../utils/errors.js';

/**
 * @param {(req: import('express').Request) => Promise<{ ownerId: string } | null>} loadResource
 *   - fetches the resource this request is about and reports its owner's user id. Return null
 *     if the resource doesn't exist at all — that's a 404, which this middleware surfaces as a
 *     generic not-found DomainError rather than silently reporting it as a 403.
 * @returns {import('express').RequestHandler}
 */
export function requireOwnership(loadResource) {
  return async (req, res, next) => {
    try {
      const resource = await loadResource(req);

      if (!resource) {
        next(new DomainError('Resource not found', { status: 404, code: ERROR_CODES.NOT_FOUND }));
        return;
      }

      if (resource.ownerId !== req.user?.id) {
        next(new ForbiddenError('You do not own this resource'));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
