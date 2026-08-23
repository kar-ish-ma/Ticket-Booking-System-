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
 * describe (Phase 3, 4, 5), not front-loaded here.
 *
 * NOTE: docs/PROJECT_PROMPT.md §9 lists a set of "stable" error codes, but that list is scoped
 * to the seat/booking/waitlist mechanisms §9 is documenting — it was never meant to be the
 * complete inventory of every code this file would ever hold. Auth (P1-5/P1-6) needed codes of
 * its own that §9 simply doesn't mention; adding them here, rather than inlining a string
 * because "the spec doesn't have one," is what CLAUDE.md's convention actually asks for.
 */

export const ERROR_CODES = Object.freeze({
  // Thrown by the last-resort error handler for anything that wasn't a recognised domain
  // error. The UI should show a generic "something went wrong, try again" message — never
  // branch on this code for specific behaviour, since it covers unknown failures by definition.
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Thrown when a request matches no route at all. The UI should treat this the same as a
  // broken link — it's a routing miss, not a domain failure.
  NOT_FOUND: 'NOT_FOUND',

  // Thrown by validate.js when a request body/query/params fails its Zod schema. The UI should
  // show the field-level details carried in error.details, not this code's message alone.
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Thrown by requireAuth when there's no valid access token (missing, malformed, expired, or
  // signed with the wrong secret). The UI should redirect to login — this is never a "retry"
  // situation, since the same request will fail again until the user re-authenticates.
  UNAUTHENTICATED: 'UNAUTHENTICATED',

  // Thrown by requireRole/requireOwnership when the caller IS authenticated but isn't allowed
  // to do this specific thing. The UI should show "you don't have access," not send the user
  // back to login — logging in again as the same user changes nothing.
  FORBIDDEN: 'FORBIDDEN',

  // Thrown by POST /auth/login on a wrong email or password. Deliberately the SAME code for
  // both cases — the UI must not be able to distinguish "no such account" from "wrong password"
  // from the error code alone, or the login form becomes a tool for discovering which emails
  // have accounts.
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  // Thrown by POST /auth/register when the email is already in use. The UI should suggest
  // logging in instead.
  EMAIL_TAKEN: 'EMAIL_TAKEN',

  // Thrown by POST /auth/refresh when the presented refresh token is missing, expired, fails
  // signature verification, or fails the DB-backed allowlist check (including the reuse-
  // detected case, where the whole token family gets revoked). The UI should treat this exactly
  // like UNAUTHENTICATED: clear local session state and redirect to login.
  REFRESH_INVALID: 'REFRESH_INVALID',

  // Thrown by Phase 2's venue/event/show CRUD on a unique-constraint violation or an invalid
  // state transition surfaced as a conflict (duplicate category name, duplicate seat grid
  // coordinate, publishing a show that's already published, ...). Deliberately one generic code
  // rather than one per resource — Phase 2 is CRUD scaffolding for Phase 3 to sit on, not a
  // scored mechanism; see "Phase 2 debt" in docs/BUILD_LOG.md. The UI should show "already
  // exists" / "already done" and let the user adjust the conflicting field.
  CONFLICT: 'CONFLICT',
});
