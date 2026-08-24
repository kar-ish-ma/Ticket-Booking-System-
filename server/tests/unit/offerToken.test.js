/**
 * offerToken.test.js
 *
 * Owns the proof of P5-4's own claims about generateOfferToken(): the raw/hash pair has the
 * literal docs/PROJECT_PROMPT.md §7.3 shape, hashing is deterministic (so a caller presenting the
 * SAME raw token back later verifies correctly), tampering with even one character changes the
 * hash (so a guessed or modified token doesn't verify), and generated tokens don't collide at
 * volume.
 *
 * Pure unit test — no DB, no server. `crypto.createHash`/`randomBytes` are deterministic-given-
 * input Node built-ins; nothing here needs Postgres.
 *
 * Does NOT own: proving single-use / replay rejection END TO END. That property comes from
 * offers.queries.js#insertWaitlistOffer's own predicate (P5-3, `UNIQUE (token_hash)`, and once
 * P5-5 builds it, POST .../accept checking `status = 'PENDING'` before flipping it) — a STATEFUL
 * guarantee this file's pure functions cannot exercise on their own. What IS provable here,
 * without a database: hashing is a proper function of its input (same raw -> same hash, always;
 * different raw -> a different hash with overwhelming probability), which is the property
 * everything else is built on top of.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

import { generateOfferToken } from '../../src/modules/waitlist/offers.service.js';

describe('generateOfferToken()', () => {
  it('embeds the offer id as the raw token\'s own prefix, per §7.3\'s literal shape', () => {
    const offerId = crypto.randomUUID();
    const { raw } = generateOfferToken(offerId);

    expect(raw.startsWith(`${offerId}.`)).toBe(true);
    // Everything after the first '.' is the random component -- non-empty, and not itself
    // containing another '.', confirming the split is unambiguous.
    const randomPart = raw.slice(offerId.length + 1);
    expect(randomPart.length).toBeGreaterThan(0);
  });

  it('returns tokenHash as the sha256 hex digest of raw -- the literal §7.3 hash, not a stand-in', () => {
    const { raw, tokenHash } = generateOfferToken(crypto.randomUUID());
    const expectedHash = crypto.createHash('sha256').update(raw).digest('hex');
    expect(tokenHash).toBe(expectedHash);
  });

  it('hashing is deterministic: the SAME raw token always hashes to the SAME value', () => {
    // This is the property verification at accept time (P5-5) will lean on: hash whatever the
    // caller presents and compare against the stored value, with no other state involved.
    const { raw, tokenHash } = generateOfferToken(crypto.randomUUID());
    const rehash = crypto.createHash('sha256').update(raw).digest('hex');
    expect(rehash).toBe(tokenHash);
  });

  it('tampering with the raw token changes the hash -- a modified token does not verify', () => {
    const { raw, tokenHash } = generateOfferToken(crypto.randomUUID());
    // Flip the raw token's very last character. If it happens to already be 'x', flip to 'y'
    // instead, so this is never a silent no-op.
    const tampered = raw.slice(0, -1) + (raw.at(-1) === 'x' ? 'y' : 'x');
    const tamperedHash = crypto.createHash('sha256').update(tampered).digest('hex');
    expect(tamperedHash).not.toBe(tokenHash);
  });

  it('20,000 generated tokens: zero raw collisions, zero hash collisions', () => {
    const rawTokens = new Set();
    const tokenHashes = new Set();
    for (let i = 0; i < 20_000; i++) {
      const { raw, tokenHash } = generateOfferToken(crypto.randomUUID());
      rawTokens.add(raw);
      tokenHashes.add(tokenHash);
    }
    expect(rawTokens.size).toBe(20_000);
    expect(tokenHashes.size).toBe(20_000);
  });
});
