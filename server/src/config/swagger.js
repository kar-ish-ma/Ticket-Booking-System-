/**
 * swagger.js
 *
 * Owns generating the OpenAPI spec (via `swagger-jsdoc`, scanning `@openapi` JSDoc blocks in
 * route files) and mounting the interactive docs UI (`swagger-ui-express`) at `/api/docs`.
 *
 * Does NOT own the OpenAPI annotations themselves — those live as JSDoc comments directly above
 * each route in its own `*.routes.js` file, not in a hand-maintained spec here. A spec generated
 * from the same comments a developer already has to write and keep accurate for the route itself
 * can't drift out of sync with the code the way a separate spec file inevitably would.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Ticket Booking System API',
      version: '0.1.0',
      description:
        'Movie and concert ticket booking platform. See docs/PROJECT_PROMPT.md for the full spec.',
    },
    servers: [{ url: env.API_URL }],
  },
  // WHY a glob over every module instead of listing files by hand:
  // A hand-maintained file list is one more thing to remember to update when a module is added —
  // exactly the kind of drift this whole mechanism exists to avoid. Every module's routes file
  // ends in .routes.js by convention (docs/FILE_MANIFEST.md), so the glob only has to be written
  // once, here, and never touched again as routes are added in later phases.
  //
  // WHY forward slashes even on Windows:
  // path.join() on Windows produces backslash-separated paths, but the glob library
  // swagger-jsdoc uses internally treats backslash as a glob escape character, not a path
  // separator. That makes a backslash pattern match zero files SILENTLY — no error, just an
  // empty spec — which is worse than a crash because it looks like it worked. Verified live:
  // the backslash form of this exact pattern found nothing; this form finds /health.
  apis: [path.join(__dirname, '../modules/**/*.routes.js').split(path.sep).join('/')],
});

/**
 * Mounts the interactive Swagger UI at /api/docs and the raw OpenAPI JSON at /api/docs.json.
 *
 * @param {import('express').Express} app
 * @returns {void}
 */
export function mountSwagger(app) {
  app.get('/api/docs.json', (req, res) => {
    res.json(spec);
  });

  // WHY no CSP override here, despite that being a common gotcha with helmet + swagger-ui:
  // The usual failure mode is swagger-ui-express embedding an inline <script> to initialise the
  // UI, which helmet's script-src 'self' (no 'unsafe-inline') then silently blocks in a browser.
  // Checked this version's actual output instead of assuming: swagger-ui.setup() here writes
  // config to a separate same-origin swagger-ui-init.js file and loads it via <script src>, not
  // inline — so script-src 'self' already covers it. The one inline style="" attribute in the
  // page shell falls back to style-src per the CSP3 spec, which already carries 'unsafe-inline'
  // in helmet's default. Global helmet() policy is sufficient; adding an override would only
  // have widened the attack surface for no actual gain.
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));
}
