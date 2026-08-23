/**
 * index.js
 *
 * Owns starting the process: binds the Express app (app.js) to a port and listens.
 *
 * Does NOT own (yet — added incrementally as their owning phases build the thing they'd operate on):
 * Socket.IO attachment (P6-1, which needs a raw http.Server in place of app.listen()), the job
 * queue poller (P1-4), the dedicated LISTEN client (P3-6), or graceful-shutdown handling that
 * drains in-flight holds before exit (P9-4, meaningless before holds exist).
 */

import app from './app.js';
import { env } from './config/env.js';

app.listen(env.PORT, () => {
  // WHY console instead of pino here:
  // No shared structured-logger instance exists yet (server/src/utils/logger.js is P9-3's job,
  // once correlation ids matter enough to need one canonical instance shared across index.js,
  // app.js, and the future job-queue workers). A one-line startup banner via console is the
  // honest floor until then — app.js's pino-http instance is the real structured logging.
  console.log(`server listening on port ${env.PORT}`);
});
