/**
 * errorHandler.js
 *
 * Owns the last-resort Express error-handling middleware. Every response this app sends follows
 * the { success, data, error: { code, message, details } } envelope (docs/PROJECT_PROMPT.md §9),
 * including error responses — a client never has to branch on envelope shape, only on
 * `success`.
 *
 * Does NOT own defining domain errors (SeatsUnavailableError, HoldExpiredError, ...) —
 * server/src/utils/errors.js does, added incrementally as each owning module needs one. Any
 * DomainError instance carries its own status and code (utils/errors.js's DomainError base
 * class); this file just reads them off. Anything that ISN'T a DomainError — a genuinely
 * unexpected failure — is an unknown 500: logged in full server-side, reported to the client as
 * a generic message that never leaks a stack trace or internal detail.
 *
 * Invariant: must be the LAST `app.use()` in app.js. Express identifies error-handling
 * middleware purely by counting declared parameters — a function isn't wired into the error
 * path unless it declares exactly four (err, req, res, next), regardless of body content — and
 * only routes an error here if something earlier in the chain called `next(err)`. Anything
 * registered after this middleware would never run on an error path, so nothing may come after it.
 */

import { ERROR_CODES } from 'shared/errors.js';
import { DomainError } from '../utils/errors.js';

/**
 * @param {Error} err - the error passed to `next(err)` by an earlier route or middleware
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next - unused, but required: Express only treats a
 *   middleware function as an error handler if it declares exactly 4 parameters
 * @returns {void}
 */
export function errorHandler(err, req, res, _next) {
  // WHY req.log instead of a module-level logger:
  // pino-http (wired in app.js) attaches a per-request child logger to req.log that already
  // carries this request's id. Logging through it means the server-side log line and the
  // requestId returned to the client below point at the exact same event, without threading a
  // correlation id through the call stack by hand. Full cross-service correlation — the same id
  // surviving into service-layer logs beyond this one handler — is P9-3's job; this is the
  // honest floor until then.
  if (err instanceof DomainError) {
    // info, not error: a wrong password or a failed role check is an expected, handled outcome,
    // not a bug. Logging it at error level would drown the genuinely unexpected failures below
    // in noise.
    (req.log ?? console).info({ code: err.code }, err.message);
    res.status(err.status).json({
      success: false,
      data: null,
      error: { code: err.code, message: err.message, details: null },
    });
    return;
  }

  (req.log ?? console).error({ err }, 'unhandled error');

  res.status(500).json({
    success: false,
    data: null,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Something went wrong. Please try again.',
      details: { requestId: req.id ?? null },
    },
  });
}
