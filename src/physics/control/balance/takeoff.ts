// Take-off planning for flashy moves (docs/design/balance-engine.md §5.3, built in Phase 5 for the
// flashy stage to use). "For jump and spin kicks, take-off decides the outcome: the plan drives COM
// velocity and angular momentum to the table's take-off values, only the gyro trims pitch and roll
// in flight, and the landing is a capture step or a brace."
//   plan      the CMP slides onto the support sole (plus an optional lean) over a weight shift of
//             shiftW / ω₀, holds there, and the DCM reference ends at take-off on
//             support point + v_takeoff / ω₀ (DcmPlan.solve's terminal offset): the COM leaves the
//             canvas over the support point moving at the asked velocity
//   ready     the body's DCM within readyM of the reference, the support sole flat, the gyro with
//             its reserve: the flashy stage launches then, or cancels (a move refused, not a fall)
//   after     the flight is the flashy stage's; on landing it calls landed(), and the engine plans
//             from the body as it is (the step adjuster and capture steps take over)
import type { Side } from '../geometry';
import type { P2 } from '../support';
import type { DcmPlan } from './dcm';

/** Tunable (exported for tools; the worker never changes it). */
export const TAKEOFF = {
  shiftW: 0.9, // the weight goes onto the support sole over this × 1/ω₀
  readyM: 0.025, // DCM error to the plan for a launch
  minLeadS: 0.15, // a take-off asked for sooner than this from now is moved to now + this
  flat: 0.97, // support sole up-axis z
  reserve: 0.5, // gyro momentum free for a launch
};

/** What the flashy stage asks for. */
export interface TakeoffRequest {
  /** The foot that stays down until the take-off (both may be planted when asked). */
  support: Side;
  /** Sim time of the take-off. */
  at: number;
  /** COM velocity wanted at take-off (world, horizontal, m/s). */
  comVel: P2;
  /** COM offset from the support sole's centre at take-off (world, m); default none. */
  lean?: P2;
}

export interface TakeoffState {
  active: boolean;
  ready: boolean;
  /** Seconds to the planned take-off (negative: late). */
  eta: number;
  /** The body's DCM against the take-off reference, m. */
  xiErr: number;
}

export function newTakeoffState(): TakeoffState {
  return { active: false, ready: false, eta: 0, xiErr: 0 };
}

/**
 * Fills `dcm` with the take-off plan from `now` (the CMP at `cmpNow`) for a support point `sole`
 * (world, the support sole's centre plus the lean): the CMP slides there over shiftW / ω, holds it to
 * `at`, and ξ(at) = sole + v / ω.
 */
export function planTakeoff(dcm: DcmPlan, now: number, cmpNow: P2, sole: P2, at: number, comVel: P2, omega: number): void {
  const tShift = Math.min(at - 0.02, now + TAKEOFF.shiftW / omega);
  dcm.clear();
  dcm.add(now, cmpNow[0], cmpNow[1]);
  if (tShift > now + 0.01) dcm.add(tShift, sole[0], sole[1]);
  dcm.add(Math.max(at, now + 0.03), sole[0], sole[1]);
  dcm.solve(omega, comVel[0] / omega, comVel[1] / omega);
}
