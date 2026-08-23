/**
 * seed.js
 *
 * Owns demo data. Today (P1-7, the "skeleton" this task asks for): one user per role,
 * idempotent. Venues, events, shows, and the deliberately-sold-out show with a pre-populated
 * waitlist (docs/FILE_MANIFEST.md's full description of this file) arrive once their owning
 * modules exist, Phase 2 onward — this file grows to seed those too; it doesn't get rewritten.
 *
 * Does NOT own: anything beyond users yet.
 */

import argon2 from 'argon2';

import { pool } from './pool.js';

// WHY a fixed, documented password instead of a random one per user:
// This is demo/grader data, not a production account — the whole point is that DEMO.md (P10-7)
// can hand a grader one password that just works for all three roles, rather than making them
// dig through a database to find out what was generated.
const DEMO_PASSWORD = 'Password123!';

const DEMO_USERS = [
  { email: 'admin@ticketbooking.test', name: 'Demo Admin', role: 'ADMIN' },
  { email: 'organiser@ticketbooking.test', name: 'Demo Organiser', role: 'ORGANISER' },
  { email: 'customer@ticketbooking.test', name: 'Demo Customer', role: 'CUSTOMER' },
];

async function seed() {
  for (const demoUser of DEMO_USERS) {
    const passwordHash = await argon2.hash(DEMO_PASSWORD);

    // WHY ON CONFLICT DO NOTHING instead of checking existence first:
    // One atomic statement, no read-then-write window. Idempotency falls out of the UNIQUE
    // (email) constraint already on the table (001_init.sql) rather than being re-implemented
    // here as an application-level check that could itself race a second seed run.
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [demoUser.email, passwordHash, demoUser.name, demoUser.role]
    );

    console.log(
      result.rowCount > 0
        ? `Created: ${demoUser.email} (${demoUser.role})`
        : `Already exists, skipped: ${demoUser.email} (${demoUser.role})`
    );
  }

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
