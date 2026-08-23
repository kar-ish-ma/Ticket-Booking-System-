/**
 * venue.schema.js
 *
 * Owns request-body validation for venue, seat-category, and bulk-seat-creation endpoints.
 * Imported by the server now and, later, an admin venue-designer UI (P8-4) — one shape, not two
 * copies that could drift.
 *
 * Does NOT own: anything about how a venue's seats are materialised into a show (shows.schema
 * lives in event.schema.js; publishShow() itself is server-only business logic).
 */

import { z } from 'zod';

// WHY every field here is optional with a default rather than required:
// layout_meta's own DB default is '{}' (001_init.sql) — an admin can create a venue and fill in
// the visual layout hints later. Nothing downstream (seat creation, publishShow, the seatmap
// query) reads rows/cols/aisleAfterCols/stagePosition; they only drive the client's grid
// renderer (P7-4), so there is no correctness reason to force them at venue-creation time.
export const layoutMetaSchema = z.object({
  rows: z.number().int().positive().optional(),
  cols: z.number().int().positive().optional(),
  aisleAfterCols: z.array(z.number().int().nonnegative()).default([]),
  stagePosition: z.enum(['TOP', 'BOTTOM', 'LEFT', 'RIGHT']).default('TOP'),
});

export const createVenueSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  city: z.string().min(1, 'City is required'),
  layoutMeta: layoutMetaSchema.optional().default({}),
});

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'colorHex must be a 6-digit hex code like #6366f1')
    .optional(),
  sortOrder: z.number().int().default(0),
});

// One row spec expands into `count` physical seats: seat_number runs startSeatNumber..+count-1,
// grid_col runs startGridCol..+count-1. Keeps the request body proportional to the venue's shape
// (a handful of row specs) instead of the seat count itself (docs/PROJECT_PROMPT.md §9's
// `rows: [{ rowLabel, count, categoryId, gridRow }]` shape).
const bulkSeatRowSchema = z.object({
  rowLabel: z.string().min(1),
  count: z.number().int().min(1).max(50),
  categoryId: z.uuid(),
  gridRow: z.number().int().nonnegative(),
  startSeatNumber: z.number().int().positive().default(1),
  startGridCol: z.number().int().nonnegative().default(0),
  isAccessible: z.boolean().default(false),
});

export const bulkCreateSeatsSchema = z.object({
  rows: z.array(bulkSeatRowSchema).min(1),
});
