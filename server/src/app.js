/**
 * app.js
 *
 * Owns the Express application: security headers, CORS, cookie parsing, request body parsing,
 * structured per-request logging, mounted routers, and the error handler. Exported separately
 * from index.js (which owns starting the actual HTTP listener) so tests can mount this app
 * directly with Supertest without binding a real port.
 *
 * Does NOT own (added incrementally as their owning phases build the thing they'd operate on):
 * starting the server (index.js), Socket.IO attachment (P6-1, needs a raw http.Server instead
 * of app.listen()), the job queue poller (P1-4), the dedicated LISTEN client (P3-6), or
 * graceful-shutdown draining of in-flight holds (P9-4, meaningless before holds exist).
 *
 * Also owns serving the static client (Decisions Ledger D-53): client/index.html, one vanilla
 * file, mounted at `/` via express.static. There is no separate client process or build step —
 * this IS the client's deploy target.
 *
 * Invariant: the error handler is always the LAST middleware registered. Express only routes an
 * error to a 4-argument middleware, and only for errors passed to next(err) by something earlier
 * in the chain — anything registered after the error handler would simply never run on an error
 * path.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { ERROR_CODES } from 'shared/errors.js';
import { env } from './config/env.js';
import { mountSwagger } from './config/swagger.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { venuesRouter } from './modules/venues/venues.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { eventShowsRouter, showsRouter } from './modules/shows/shows.routes.js';
import { seatmapRouter } from './modules/seatmap/seatmap.routes.js';
import { holdsRouter } from './modules/holds/holds.routes.js';
import { bookingsRouter } from './modules/bookings/bookings.routes.js';
import { showWaitlistRouter } from './modules/waitlist/waitlist.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WHY ../../client: this file lives at server/src/app.js, so two levels up (src -> server ->
// repo root) reaches the repo root, where client/ sits as a sibling of server/ (D-53 — no longer
// an npm workspace, just a plain static directory).
const CLIENT_DIR = path.join(__dirname, '../../client');

const app = express();

app.use(
  helmet({
    // WHY script-src needs 'unsafe-inline' here, unlike the Swagger UI page (Decisions Ledger
    // D-19, which needed no CSP relaxation at all): client/index.html is deliberately ONE file
    // with its JS inline, not a separate same-origin <script src> file the default 'self'
    // already covers. The trade-off is scoped to this one directive; every dynamic value the
    // inline script writes into the DOM goes through textContent, never innerHTML, so relaxing
    // script-src doesn't itself open an injection path — it only permits the inline block to
    // run at all.
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

app.use(
  cors({
    // WHY a concrete origin instead of `origin: true` (reflect any origin):
    // `origin: true` works with `credentials: true` too, but it accepts every caller. Reading
    // the validated WEB_URL means the allowed origin can never silently diverge from what
    // env.js already confirmed is configured — get it wrong and the server refuses to boot
    // (P0-5), rather than serving with a CORS policy nobody checked.
    origin: env.WEB_URL,
    credentials: true, // httpOnly auth cookies (P1-5) require this
  })
);

app.use(cookieParser());
app.use(express.json());
app.use(pinoHttp());

app.use('/health', healthRouter);
// WHY /api/v1: docs/PROJECT_PROMPT.md §9 bases the whole domain API here (health and the
// Swagger UI are the two deliberate exceptions, listed outside it in §9 itself).
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/venues', venuesRouter);
app.use('/api/v1/events', eventsRouter);
// WHY mounted at the same path as the show-detail/publish routes below: this router only
// handles POST / (i.e. POST /api/v1/events/:eventId/shows), scoped to its parent event by
// { mergeParams: true } (shows.routes.js). Nesting it under /events instead of /shows keeps
// "create a show" reading as "add a show to this event," matching docs/PROJECT_PROMPT.md §9.
app.use('/api/v1/events/:eventId/shows', eventShowsRouter);
app.use('/api/v1/shows', showsRouter);
app.use('/api/v1/shows', seatmapRouter);
app.use('/api/v1/holds', holdsRouter);
app.use('/api/v1/bookings', bookingsRouter);
// WHY mounted the same way as eventShowsRouter (a mergeParams router scoped by a URL segment)
// rather than nested under showsRouter directly: this router only handles POST / today and grows
// with P5-2/P5-5's GET /me, DELETE /, and offer-claim routes, none of which belong to showsRouter's
// own concerns (show CRUD/publish).
app.use('/api/v1/shows/:showId/waitlist', showWaitlistRouter);
mountSwagger(app);

// WHY mounted after every /api/v1 and /health route, not before: express.static falls through
// (calls next()) for any request that doesn't match a real file, so ordering it first would be
// harmless for API paths — but ordering it here keeps the routing story readable top-to-bottom:
// API first, then the one static asset this server also happens to serve.
app.use(express.static(CLIENT_DIR));

// WHY a 404 handler here, before the error handler:
// A route that simply doesn't exist doesn't throw — Express falls through every app.use() that
// doesn't match and, with nothing left, would otherwise send its own default HTML 404 page. This
// turns "no route matched" into the same envelope every other response uses.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    data: null,
    error: { code: ERROR_CODES.NOT_FOUND, message: 'Route not found', details: null },
  });
});

// Invariant: must stay last. See file header.
app.use(errorHandler);

export default app;
