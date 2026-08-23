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
   * @param {{ status: number, code: string }} options
   */
  constructor(message, { status, code }) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
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
