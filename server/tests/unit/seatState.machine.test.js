/**
 * seatState.machine.test.js
 *
 * Owns the full legal/illegal transition matrix proof for
 * seatState.machine.js#assertTransition(), plus the immutability guarantee on
 * shared/seatStates.js#SEAT_TRANSITIONS that the same file's header comment claims.
 *
 * Pure unit test — no DB, no server, no network. This is why it's the first automated test in
 * the project: everything before Phase 3 was proven live against a real Postgres/HTTP instead
 * (see docs/TESTING.md), because the mechanisms being proven all needed a real database. This
 * one doesn't.
 */

import { describe, it, expect } from 'vitest';
import { SEAT_STATES, SEAT_TRANSITIONS } from 'shared/seatStates.js';
import { assertTransition } from '../../src/modules/seatmap/seatState.machine.js';
import { IllegalSeatTransitionError } from '../../src/utils/errors.js';

const ALL_STATES = Object.values(SEAT_STATES);

// WHY this set is written out by hand instead of derived from SEAT_TRANSITIONS: deriving it from
// the same map assertTransition() reads would make this test tautological — it would prove
// assertTransition() agrees with the map, never that the map agrees with
// docs/PROJECT_PROMPT.md §4.3. Copied from that table verbatim (including the
// OFFER_RESERVED -> OFFER_RESERVED cascade self-loop — see shared/seatStates.js's WHY comment on
// it), this fails if either the map OR the guard function drifts from spec.
const LEGAL_PAIRS = new Set([
  'AVAILABLE->HELD',
  'AVAILABLE->BLOCKED',
  'HELD->BOOKED',
  'HELD->AVAILABLE',
  'BOOKED->AVAILABLE',
  'BOOKED->OFFER_RESERVED',
  'OFFER_RESERVED->BOOKED',
  'OFFER_RESERVED->OFFER_RESERVED',
  'OFFER_RESERVED->AVAILABLE',
  'BLOCKED->AVAILABLE',
]);

describe('seatState.machine#assertTransition — full 5x5 matrix', () => {
  const allPairs = ALL_STATES.flatMap((from) => ALL_STATES.map((to) => [from, to]));

  it.each(allPairs)('%s -> %s', (from, to) => {
    if (LEGAL_PAIRS.has(`${from}->${to}`)) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(IllegalSeatTransitionError);
    }
  });

  it('throws for an unrecognised fromState', () => {
    expect(() => assertTransition('NOT_A_REAL_STATE', SEAT_STATES.HELD)).toThrow(
      IllegalSeatTransitionError
    );
  });

  it('throws for an unrecognised toState', () => {
    expect(() => assertTransition(SEAT_STATES.AVAILABLE, 'NOT_A_REAL_STATE')).toThrow(
      IllegalSeatTransitionError
    );
  });
});

describe('SEAT_TRANSITIONS immutability', () => {
  it('the outer map is frozen', () => {
    expect(Object.isFrozen(SEAT_TRANSITIONS)).toBe(true);
  });

  it('reassigning a key throws and does not mutate it', () => {
    const before = SEAT_TRANSITIONS[SEAT_STATES.AVAILABLE];

    // ESM modules always run in strict mode, so writing to a non-writable property of a frozen
    // object throws TypeError rather than silently no-op'ing.
    expect(() => {
      SEAT_TRANSITIONS[SEAT_STATES.AVAILABLE] = ['SOMETHING_ELSE'];
    }).toThrow(TypeError);
    expect(SEAT_TRANSITIONS[SEAT_STATES.AVAILABLE]).toBe(before);
  });

  it('every legal-target array is frozen too, not just the outer object', () => {
    // Object.freeze() is shallow -- freezing SEAT_TRANSITIONS alone would stop reassigning a key
    // but do nothing to stop SEAT_TRANSITIONS.HELD.push(...) mutating the array that key points
    // to. Each array must be frozen individually; this test fails if that ever regresses.
    for (const state of ALL_STATES) {
      expect(Object.isFrozen(SEAT_TRANSITIONS[state])).toBe(true);
    }
  });

  it('mutating a legal-target array in place throws and does not change its contents', () => {
    const before = [...SEAT_TRANSITIONS[SEAT_STATES.HELD]];
    expect(() => {
      SEAT_TRANSITIONS[SEAT_STATES.HELD].push('SOMETHING_ELSE');
    }).toThrow(TypeError);
    expect(SEAT_TRANSITIONS[SEAT_STATES.HELD]).toEqual(before);
  });
});
