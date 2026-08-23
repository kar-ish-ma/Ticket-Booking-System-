/**
 * errors.js
 *
 * Owns the canonical, stable error-code strings used in every API error envelope
 * ({ success, data, error: { code, message, details } } — docs/PROJECT_PROMPT.md §9). The
 * server throws these; the client switches on them to decide what to show the user. Neither
 * side ever inlines a raw error string — see CLAUDE.md's Conventions section.
 *
 * Does NOT own: HTTP status mapping (that's each error's own concern where it's thrown, or
 * server/src/middleware/errorHandler.js for the unknown-error fallback) or user-facing copy
 * (the client owns how a code is worded on screen).
 *
 * This file grows as each module is built — domain-specific codes (SEATS_UNAVAILABLE,
 * HOLD_EXPIRED, OFFER_INVALID, ...) are added by the phase that introduces the mechanism they
 * describe (Phase 3, 4, 5), not front-loaded here. Today it holds only the two generic codes a
 * bare Express skeleton needs.
 */

export const ERROR_CODES = Object.freeze({
  // Thrown by the last-resort error handler for anything that wasn't a recognised domain
  // error. The UI should show a generic "something went wrong, try again" message — never
  // branch on this code for specific behaviour, since it covers unknown failures by definition.
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Thrown when a request matches no route at all. The UI should treat this the same as a
  // broken link — it's a routing miss, not a domain failure.
  NOT_FOUND: 'NOT_FOUND',
});
