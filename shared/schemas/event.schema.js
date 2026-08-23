/**
 * event.schema.js
 *
 * Owns request-body/query validation for events and shows: creation, update, public browse
 * filters, and per-show category pricing.
 *
 * Does NOT own: venue/category/seat shapes (venue.schema.js) or anything about how a show's
 * seat map is materialised (publishShow() is server-only business logic, not a request shape).
 */

import { z } from 'zod';

export const createEventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  type: z.enum(['MOVIE', 'CONCERT']),
  description: z.string().optional().default(''),
  posterUrl: z.url().optional(),
  language: z.string().optional(),
  genre: z.string().optional(),
  durationMin: z.number().int().positive(),
});

// WHY a hand-written schema instead of createEventSchema.partial():
// .partial() only makes every field optional -- it does NOT strip a field's own .default().
// createEventSchema's `description` is `z.string().optional().default('')`; under .partial() an
// absent `description` key still gets parsed into `description: ''` rather than staying absent.
// events.queries.js#updateEvent only applies keys actually present in the patch (PATCH
// semantics, not PUT) -- but validate.js hands it Zod's *parsed* object, where that default has
// already filled the key in. The result: PATCH { isPublished: true } alone would silently wipe
// an existing event's description to ''. Found live testing P2-4 -- a real event's description
// was overwritten this way before this fix. None of these fields carry a .default() here, so an
// omitted key stays omitted through parsing, exactly what a partial update needs.
export const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  type: z.enum(['MOVIE', 'CONCERT']).optional(),
  description: z.string().optional(),
  posterUrl: z.url().optional(),
  language: z.string().optional(),
  genre: z.string().optional(),
  durationMin: z.number().int().positive().optional(),
  isPublished: z.boolean().optional(),
});

// WHY z.coerce.date() for dateFrom/dateTo: these arrive as query-string values (validate.js
// runs this against req.query), so they're always raw strings on the wire — coercion is what
// turns "2026-09-01" into an actual Date before events.queries.js ever sees it.
export const browseEventsSchema = z.object({
  type: z.enum(['MOVIE', 'CONCERT']).optional(),
  city: z.string().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
});

const showPriceSchema = z.object({
  categoryId: z.uuid(),
  priceCents: z.number().int().nonnegative(),
});

// WHY holdTtlSeconds/offerTtlSeconds are optional here with no schema-level default:
// shows.hold_ttl_seconds and offer_ttl_seconds already have DB defaults (600 / 900,
// 002_events_shows.sql) matching SEAT_HOLD_TTL_SECONDS / WAITLIST_OFFER_TTL_SECONDS. Omitting a
// schema default lets the INSERT's own DEFAULT clause apply instead of this file having to know
// the env-configured value.
export const createShowSchema = z.object({
  venueId: z.uuid(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  holdTtlSeconds: z.number().int().positive().optional(),
  offerTtlSeconds: z.number().int().positive().optional(),
  prices: z.array(showPriceSchema).min(1, 'At least one category price is required'),
});
