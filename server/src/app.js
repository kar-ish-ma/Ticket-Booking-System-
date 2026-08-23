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
 * Invariant: the error handler is always the LAST middleware registered. Express only routes an
 * error to a 4-argument middleware, and only for errors passed to next(err) by something earlier
 * in the chain — anything registered after the error handler would simply never run on an error
 * path.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { ERROR_CODES } from 'shared/errors.js';
import { env } from './config/env.js';
import { healthRouter } from './modules/health/health.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(helmet());

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
