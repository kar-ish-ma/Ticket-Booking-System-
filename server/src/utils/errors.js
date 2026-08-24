/**
 * errors.js
 *
 * Owns domain-specific error classes -- typed errors a service layer throws so
 * errorHandler.js (or a controller that wants to catch one specifically) knows exactly which
 * HTTP status and shared/errors.js code to respond with, instead of every service inlining its
 * own res.status(...).json(...) call or duplicating the same status/code pairing in multiple
 * places.
 *
 * Does NOT own mapping these to HTTP responses -- errorHandler.js does, by checking
 * `instanceof DomainError`. Controllers never need their own try/catch for these; the whole
 * point is that a thrown DomainError propagates to the one place that already knows how to
 * respond.
 *
 * Grows as each module needs a new domain error -- SeatsUnavailableError, HoldExpiredError,
 * OfferInvalidError and IllegalSeatTransitionError (docs/FILE_MANIFEST.md) arrive with Phase 3.
 * Auth's errors are added now, at P1-5/P1-6, because auth is the first module that needs any.
 */

import { ERROR_CODES } from 'shared/errors.js';

export class DomainError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code: string, details?: unknown }} options - `details` is
   *   whatever structured data the error needs the client to see beyond the message (e.g.
   *   SeatsUnavailableError's conflicting seat labels). Defaults to null, matching the response
   *   envelope's `error.details` shape when there's nothing extra to say.
   */
  constructor(message, { status, code, details = null }) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    // WHY the exact same message for "no such user" and "wrong password":
    // shared/errors.js's INVALID_CREDENTIALS comment explains why -- the login endpoint must
    // not become a tool for discovering which emails have accounts.
    super('Invalid email or password', { status: 401, code: ERROR_CODES.INVALID_CREDENTIALS });
  }
}

export class EmailTakenError extends DomainError {
  constructor() {
    super('Email is already registered', { status: 409, code: ERROR_CODES.EMAIL_TAKEN });
  }
}

// WHY this exists as a reusable class rather than validate.js's inline 422 response: validate.js
// only ever sees a request BEFORE it reaches a service, so it can't enforce a rule that needs
// server-only config (env) or a DB lookup. holds.service.js#createHold's MAX_SEATS_PER_BOOKING
// cap is exactly that case -- shared/schemas/hold.schema.js can't read env, so the cap is
// enforced here instead. Any future service-layer check with the same shape (right request
// shape, but a business rule beyond what a shared Zod schema alone can express) reuses this
// rather than each inventing its own 422.
export class ValidationError extends DomainError {
  constructor(message) {
    super(message, { status: 422, code: ERROR_CODES.VALIDATION_ERROR });
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: ERROR_CODES.UNAUTHENTICATED });
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have access to this resource') {
    super(message, { status: 403, code: ERROR_CODES.FORBIDDEN });
  }
}

export class RefreshInvalidError extends DomainError {
  constructor(message = 'Refresh token is invalid or expired') {
    super(message, { status: 401, code: ERROR_CODES.REFRESH_INVALID });
  }
}

// WHY these two are generic (reusable across venues/events/shows) instead of one class per
// resource: Phase 2 is CRUD scaffolding, not a scored mechanism — see shared/errors.js's
// CONFLICT comment and "Phase 2 debt" in docs/BUILD_LOG.md.
export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found') {
    super(message, { status: 404, code: ERROR_CODES.NOT_FOUND });
  }
}

export class ConflictError extends DomainError {
  constructor(message = 'Resource already exists or conflicts with existing data') {
    super(message, { status: 409, code: ERROR_CODES.CONFLICT });
  }
}

// WHY status 409, not 500, even though this represents an internal invariant violation rather
// than expected client-facing contention (see shared/errors.js's ILLEGAL_SEAT_TRANSITION
// comment): docs/PROJECT_PROMPT.md §4.3/§9 name this error but never pin a status, so it's a real
// judgment call — logged as Decisions Ledger D-33. 409 groups it with SEATS_UNAVAILABLE/
// OFFER_INVALID in the "this resource's state conflicts with the request" family, which is what
// it IS from an HTTP-semantics standpoint even though it should never actually fire in correct
// code. 500 would mislabel it as "the server broke," which overstates it — nothing crashed,
// something upstream just computed the wrong `fromState`. Either was defensible; 409 read as the
// more honest description of what happened.
export class IllegalSeatTransitionError extends DomainError {
  constructor(message = 'Illegal seat state transition') {
    super(message, { status: 409, code: ERROR_CODES.ILLEGAL_SEAT_TRANSITION });
  }
}

/**
 * @param {Array<{ seatId: string, rowLabel: string, seatNumber: number }>} conflictingSeats -
 *   the requested seats that could NOT be acquired, so the UI can flash exactly those red
 *   (docs/PROJECT_PROMPT.md §6.1) instead of the whole map or nothing.
 */
export class SeatsUnavailableError extends DomainError {
  constructor(conflictingSeats) {
    super('One or more requested seats are unavailable', {
      status: 409,
      code: ERROR_CODES.SEATS_UNAVAILABLE,
      details: { conflictingSeats },
    });
  }
}

// WHY 410 (Gone), not 404 or 409: the hold this request named DID exist and WAS valid -- it just
// isn't anymore, and never will be again under this id (unlike SEATS_UNAVAILABLE's 409, which
// describes a request that could succeed against a DIFFERENT seat). 410 is the one status whose
// HTTP semantics mean exactly that: the resource existed, is now permanently gone, don't retry.
export class HoldExpiredError extends DomainError {
  constructor(message = 'This hold is no longer active') {
    super(message, { status: 410, code: ERROR_CODES.HOLD_EXPIRED });
  }
}
