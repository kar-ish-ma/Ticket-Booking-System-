/**
 * auth.schema.js
 *
 * Owns request-body validation for the auth endpoints. Imported by both the server
 * (middleware/validate.js, on every request) and, later, the client (P7-2, so a form can show
 * the same validation error before ever hitting the network) — one schema, not two copies that
 * could drift.
 *
 * Does NOT own: anything about tokens, cookies, or password hashing. Purely the shape of what a
 * client is allowed to send.
 */

import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email(),
  // WHY 8, not some higher "strong password" bar: this is a demo booking platform, not a bank.
  // The real security boundary is argon2 hashing (auth.service.js) and never logging the raw
  // password anywhere, not the length of a client-side rule that's trivially bypassed anyway.
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  // WHY role is accepted here at all, given only ADMIN/ORGANISER/CUSTOMER exist and a public
  // register endpoint letting someone self-assign ADMIN would be a real vulnerability:
  // the Zod shape only constrains WHICH strings are syntactically valid. auth.service.js is
  // what actually decides which roles a public registration is allowed to grant — see its
  // header comment. Keeping that decision out of the schema means the schema can be shared
  // with a future admin-only "create organiser" endpoint that DOES need to accept a role.
  role: z.enum(['ADMIN', 'ORGANISER', 'CUSTOMER']).optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, 'Password is required'),
});
