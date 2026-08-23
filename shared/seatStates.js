/**
 * seatStates.js
 *
 * Owns the seat state machine's vocabulary and its legal-transition graph — imported by BOTH the
 * server (seatState.machine.js's assertTransition() guard) and the client (the seat map's colour
 * mapper, P7-4). One definition means the UI's colour-per-state legend and the server's
 * transition guard can never silently drift apart.
 *
 * Does NOT own: enforcing the graph (seatState.machine.js, server-only — the client only reads
 * these constants to pick a colour, it never decides whether a transition is legal).
 *
 * Invariant: both exports are frozen. This file is imported into two different runtimes; an
 * accidental mutation in one (e.g. a client component pushing an extra state onto an array at
 * render time) would silently desync the other's idea of what's legal — frozen means that
 * mutation fails loudly (in strict mode) or silently no-ops instead of corrupting shared state.
 */

/**
 * The five states a `show_seats.state` column can hold — mirrors the `seat_state_t` Postgres
 * enum (001_init.sql) exactly. Referenced by key (`SEAT_STATES.HELD`), never as a bare string
 * literal, so a typo becomes an `undefined` reference error instead of a silently-wrong state.
 */
export const SEAT_STATES = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  OFFER_RESERVED: 'OFFER_RESERVED',
  BOOKED: 'BOOKED',
  BLOCKED: 'BLOCKED',
});

/**
 * The legal-transition graph from docs/PROJECT_PROMPT.md §4.3, verbatim. Every key is a FROM
 * state; every value is the array of TO states reachable from it in one step. A pair not listed
 * here — including any (state, state) pair not explicitly named below — is illegal and
 * seatState.machine.js#assertTransition() throws on it.
 *
 * WHY every array is frozen individually, not just the outer object: `Object.freeze()` is
 * shallow. Freezing only the outer object stops `SEAT_TRANSITIONS.HELD = [...]` (reassigning a
 * key) but does nothing to stop `SEAT_TRANSITIONS.HELD.push('BLOCKED')` (mutating the array that
 * key already points to) — the outer object's own keys never changed, so the outer freeze never
 * even sees it. That second form is the more likely accidental mutation in practice (code that
 * means to just READ the legal targets for a state and instead calls a mutating array method on
 * the result), so every array gets its own freeze too.
 */
export const SEAT_TRANSITIONS = Object.freeze({
  [SEAT_STATES.AVAILABLE]: Object.freeze([SEAT_STATES.HELD, SEAT_STATES.BLOCKED]),
  [SEAT_STATES.HELD]: Object.freeze([SEAT_STATES.BOOKED, SEAT_STATES.AVAILABLE]),
  [SEAT_STATES.BOOKED]: Object.freeze([SEAT_STATES.AVAILABLE, SEAT_STATES.OFFER_RESERVED]),
  // WHY OFFER_RESERVED -> OFFER_RESERVED is listed as a LEGAL transition, not an omission:
  // this is the cascade case (docs/PROJECT_PROMPT.md §7.4) — an offer lapses and the same seats
  // get re-offered to the next person in the waitlist queue. The seat's `state` column never
  // actually changes (it's OFFER_RESERVED both before and after), but attempt_no increments and
  // a new token is minted, so the *offer* changed even though the *seat state* didn't. Read cold
  // in four months, a self-loop in a transition map looks exactly like a no-op someone forgot to
  // delete — it isn't. It's the one entry here that represents "the state stayed the same on
  // purpose," and it earns its place in the map for that reason: without it, a legitimate cascade
  // would throw IllegalSeatTransitionError.
  [SEAT_STATES.OFFER_RESERVED]: Object.freeze([
    SEAT_STATES.BOOKED,
    SEAT_STATES.OFFER_RESERVED,
    SEAT_STATES.AVAILABLE,
  ]),
  [SEAT_STATES.BLOCKED]: Object.freeze([SEAT_STATES.AVAILABLE]),
});
