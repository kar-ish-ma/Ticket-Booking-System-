/**
 * env.js
 *
 * Owns reading and validating every environment variable this server depends on, once, at
 * import time. Every other module reads config through the `env` object this file exports —
 * never through `process.env` directly (CLAUDE.md: "All config via env, validated with Zod at
 * boot. No magic numbers in code.").
 *
 * Does NOT own: client-side env vars (Vite's own `VITE_*` mechanism, added at P7-1), or values
 * with no env-var equivalent — show_seats.reserved_until, for example, is *derived* from
 * WAITLIST_OFFER_TTL_SECONDS and WAITLIST_MAX_CASCADE_ATTEMPTS rather than being its own
 * setting (see Decisions Ledger D-14).
 *
 * Invariant: this module has no recovery path for an invalid or missing required variable. A
 * failed validation prints a readable report and exits the process before a single request can
 * be served. A server that "mostly" started with wrong config is worse than one that never
 * started — half-configured is exactly what this guards against.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WHY the repo root, not server/.env:
// .env.example lives at the repo root (docs/FILE_MANIFEST.md) — one file for the one thing that
// currently needs env vars. A separate client/.env for Vite's VITE_*-prefixed vars is a P7-1
// concern, not this file's.
const envPath = path.resolve(__dirname, '../../../.env');

// WHY guarded instead of unconditional:
// process.loadEnvFile() throws ENOENT if the file is missing. That's the expected case in CI
// and production, where real environment variables are injected by the platform instead of read
// from a file — .env is a local-dev convenience, never a requirement.
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// What jsonwebtoken's `expiresIn` accepts: a bare number of seconds, or digits followed by a
// single s/m/h/d/w unit.
const durationPattern = /^\d+(s|m|h|d|w)$/;

// node-cron's five-or-six-field syntax (an optional leading seconds field). Not a full syntactic
// validator — that's node-cron's own job when it actually parses the string (added with the
// scheduler itself, P3-7/P4-6) — just enough here to catch an empty string or an obviously wrong
// shape at boot instead of at the first missed run.
const cronPattern = /^(\S+\s+){4,5}\S+$/;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    API_URL: z.url().default('http://localhost:3000'),
    // WHY this now defaults to the server's own origin, not a separate :5173: since D-53, the
    // client is client/index.html served BY this Express process via express.static — there is
    // no separate client dev server for WEB_URL to point at anymore.
    WEB_URL: z.url().default('http://localhost:3000'),

    // No default: a wrong or missing DATABASE_URL must never silently point at nothing.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PGPOOL_MAX: z.coerce.number().int().positive().default(10),

    JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    // Secrets: no defaults, ever. A checked-in default secret is a vulnerability, not a
    // convenience.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().regex(durationPattern).default('15m'),
    JWT_REFRESH_TTL: z.string().regex(durationPattern).default('7d'),

    QR_SIGNING_SECRET: z.string().min(32, 'QR_SIGNING_SECRET must be at least 32 characters'),

    SEAT_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    WAITLIST_OFFER_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    WAITLIST_MAX_CASCADE_ATTEMPTS: z.coerce.number().int().positive().default(5),

    HOLD_RECONCILER_CRON: z.string().regex(cronPattern).default('*/30 * * * * *'),
    OUTBOX_RECONCILER_CRON: z.string().regex(cronPattern).default('*/60 * * * * *'),

    MAX_SEATS_PER_BOOKING: z.coerce.number().int().positive().default(6),

    // Left blank in dev on purpose — Nodemailer auto-creates an Ethereal test account when
    // SMTP_HOST is empty (server/src/mail/mailer.js, P4-7). Only required once a real SMTP
    // provider is configured for production.
    SMTP_HOST: z.string().default(''),
    // WHY the preprocess step: SMTP_PORT="" (an empty-but-present line, exactly what
    // .env.example ships) coerces to the NUMBER 0 via plain z.coerce.number() -- JS's Number('')
    // is 0, not NaN -- which then fails .positive() with a confusing error instead of just being
    // treated as "not set." Caught live running the P1-1 migration against a real .env.
    SMTP_PORT: z.preprocess(
      (val) => (val === '' ? undefined : val),
      z.coerce.number().int().positive().optional()
    ),
    SMTP_USER: z.string().default(''),
    SMTP_PASS: z.string().default(''),
    MAIL_FROM: z.string().default(''),

    BOOKING_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
    RATE_LIMIT_HOLD_PER_MIN: z.coerce.number().int().positive().default(10),
  })
  // WHY a secret-distinctness check instead of trusting each var in isolation:
  // Decisions Ledger D-10: the QR token is signed with its own secret specifically so a leaked
  // ticket-verification key can't be replayed to mint an auth session. That guarantee is only
  // real if the two secrets actually differ — enforcing it here means a copy-paste mistake in
  // .env fails loudly at boot instead of silently weakening the isolation.
  .superRefine((val, ctx) => {
    if (
      val.QR_SIGNING_SECRET === val.JWT_ACCESS_SECRET ||
      val.QR_SIGNING_SECRET === val.JWT_REFRESH_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['QR_SIGNING_SECRET'],
        message:
          'QR_SIGNING_SECRET must differ from JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (see Decisions Ledger D-10)',
      });
    }
  });

const result = schema.safeParse(process.env);

if (!result.success) {
  // WHY console instead of pino here:
  // This runs before pino-http, or anything else in the app, exists — env.js is the first thing
  // every other module imports. Console is the only logger available this early.
  console.error('Invalid environment configuration:\n' + z.prettifyError(result.error));
  process.exit(1);
}

export const env = result.data;
