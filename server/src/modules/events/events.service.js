/**
 * events.service.js
 *
 * Owns event business logic: creation (organiser becomes the owner), ownership-checked update,
 * and the public browse/detail reads.
 *
 * Does NOT own: HTTP concerns (events.controller.js) or the SQL itself (events.queries.js).
 */

import { pool } from '../../db/pool.js';
import { NotFoundError } from '../../utils/errors.js';
import * as eventsQueries from './events.queries.js';

/**
 * @param {string} organiserId - req.user.id; the caller is always the owner of an event they create
 * @param {object} input - validated createEventSchema shape
 * @returns {Promise<object>}
 */
export async function createEvent(organiserId, input) {
  return eventsQueries.insertEvent(pool, { organiserId, ...input });
}

/**
 * WHY no is_published gate here, unlike listPublishedEvents: an organiser must be able to fetch
 * their own unpublished event by id — to edit it, or to attach shows to it (P2-5) — and this
 * function is also what requireOwnership's loader reuses (events.routes.js) to find who owns the
 * event a PATCH targets. Gating a public detail page by publish status is real product behaviour
 * this phase deliberately skips — see "Phase 2 debt" in docs/BUILD_LOG.md.
 *
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {NotFoundError} if no event has this id
 */
export async function getEvent(id) {
  const event = await eventsQueries.findEventById(pool, id);
  if (!event) throw new NotFoundError('Event not found');
  return event;
}

/**
 * WHY this takes no organiserId and does no ownership check: the route already ran
 * requireOwnership before this is called (events.routes.js) — re-checking here would just repeat
 * the same query. This function trusts the route chain, matching auth.service.js's pattern of
 * keeping authorization decisions at the boundary that owns them.
 *
 * @param {string} id
 * @param {object} patch - validated updateEventSchema shape (partial)
 * @returns {Promise<object>}
 * @throws {NotFoundError} if no event has this id
 */
export async function updateEvent(id, patch) {
  const event = await eventsQueries.updateEvent(pool, id, patch);
  if (!event) throw new NotFoundError('Event not found');
  return event;
}

/**
 * @param {object} filters - validated browseEventsSchema shape
 * @returns {Promise<{ events: object[], total: number, page: number, pageSize: number }>}
 */
export async function browseEvents(filters) {
  return eventsQueries.listPublishedEvents(pool, filters);
}

/**
 * The `loadResource` requireOwnership.js expects: fetch the resource, report who owns it, or
 * null if it doesn't exist at all. Kept separate from getEvent() because that one throws
 * NotFoundError on a miss (right for a route handler); requireOwnership.js wants a plain null so
 * it can turn a miss into its own 404, not catch an exception to detect the same thing.
 *
 * WHY `req.params.id ?? req.params.eventId`: reused by two different route shapes —
 * events.routes.js's PATCH /events/:id (param `id`) and shows.routes.js's
 * POST /events/:eventId/shows (param `eventId`, since `:id` there would refer to the show being
 * created, which doesn't exist yet). Both are "does the caller own this event" checks, so one
 * loader covers both instead of a near-duplicate copy per route file.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ ownerId: string } | null>}
 */
export async function loadEventForOwnership(req) {
  const event = await eventsQueries.findEventById(pool, req.params.id ?? req.params.eventId);
  return event ? { ownerId: event.organiserId } : null;
}
