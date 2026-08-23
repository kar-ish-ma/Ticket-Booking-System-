/**
 * validate.js
 *
 * Owns turning a Zod schema into Express middleware: run the schema against one part of the
 * request, replace that part with the parsed (and now type-coerced/defaulted) result, or
 * respond 422 with field-level details.
 *
 * Does NOT own the schemas themselves -- those live in shared/schemas/*.schema.js, imported by
 * both server and client so a validation rule can't drift between what the form checks and what
 * the API enforces.
 */

import { ERROR_CODES } from 'shared/errors.js';

/**
 * @param {import('zod').ZodType} schema
 * @param {'body' | 'query' | 'params'} [source]
 * @returns {import('express').RequestHandler}
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      res.status(422).json({
        success: false,
        data: null,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Invalid request',
          // Each issue carries `path` (which field) and `message` (what's wrong with it) --
          // enough for a client to highlight the specific field, not just show one generic
          // error for the whole form.
          details: result.error.issues,
        },
      });
      return;
    }

    // WHY reassigning req[source] instead of leaving the original body/query/params alone:
    // Zod's parse result carries defaults and coercions (e.g. a query string "5" becoming the
    // number 5) that the raw request never had. Every handler downstream should see the
    // validated, normalised value -- reading req.body directly after this middleware would
    // silently skip that normalisation.
    req[source] = result.data;
    next();
  };
}
