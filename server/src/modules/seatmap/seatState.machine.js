/**
 * seatState.machine.js
 *
 * Owns the single guard every seat state change in this codebase must pass through:
 * assertTransition(). Pure and synchronous — no DB, no async, no knowledge of `expires_at` /
 * `reserved_until` or lazy expiry. It only knows the abstract graph in shared/seatStates.js.
 *
 * Does NOT own: resolving a `show_seats` row's raw stored state into its EFFECTIVE state. An
 * expired HELD row reclaimed by the atomic acquire (Phase 3) is, per lazy expiry (CLAUDE.md,
 * Decisions Ledger D-2), logically AVAILABLE the instant `expires_at` passes — the caller must
 * pass THAT as `fromState`, not the stale stored value, or a legitimate reclaim reads as an
 * illegal `HELD -> HELD` transition, which isn't even in the map (HELD only ever moves to BOOKED
 * or AVAILABLE). `seatmap.queries.js` computes that resolution for reads; `holds.queries.js`'s
 * acquire predicate computes it for writes, atomically, in the same statement that performs the
 * transition — this file has no opinion on how that resolution happens, only on whether a given
 * (fromState, toState) pair is legal once someone else has resolved it.
 *
 * Invariant (CLAUDE.md): every state change in this codebase routes through this function.
 */

import { SEAT_TRANSITIONS } from 'shared/seatStates.js';
import { IllegalSeatTransitionError } from '../../utils/errors.js';

/**
 * @param {string} fromState - the seat's EFFECTIVE current state (see file header) — not
 *   necessarily what's physically stored in `show_seats.state`
 * @param {string} toState - the state the caller wants to move it to
 * @returns {void}
 * @throws {IllegalSeatTransitionError} if `fromState` isn't a recognised state, or the
 *   (fromState, toState) pair isn't in shared/seatStates.js's SEAT_TRANSITIONS map
 */
export function assertTransition(fromState, toState) {
  const legalTargets = SEAT_TRANSITIONS[fromState];

  // WHY one branch covers both "fromState isn't a real state" and "the transition is illegal":
  // an unrecognised fromState has no entry in SEAT_TRANSITIONS at all, so legalTargets is
  // undefined — calling .includes() on it would throw its own misleading TypeError instead of
  // the domain error this function promises. Checking `!legalTargets` first collapses that into
  // the same clean IllegalSeatTransitionError as a real-but-illegal pair, with no separate
  // "is this even a valid state" validation step that would need to be kept in sync with
  // SEAT_STATES by hand.
  if (!legalTargets || !legalTargets.includes(toState)) {
    throw new IllegalSeatTransitionError(`Illegal seat transition: ${fromState} -> ${toState}`);
  }
}
