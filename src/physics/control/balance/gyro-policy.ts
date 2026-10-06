// Gyro policy v1 (docs/design/balance-engine.md §3.7). The core is an emergency reserve, not a
// posture servo: no stiffness terms. It is asked for
//   damping     τ = −b_g·ω_torso in pitch and roll, b_g = 0.06·m·g·z_c (GyBAR: a torso damper
//               helps without regulating a posture), only while the rotor is under half full
//               (tapering 0.4-0.6 H), so it is never the thing that fills it;
//   emergency   the CMP shift the soles cannot reach (allocation remainder), as a couple
//               m·g·(Δy, −Δx); emergencies may use all of the momentum;
// and it gives its momentum back (bleed) only in double support with the DCM at least 3 cm inside
// the support, no faster than the soles can carry the unloading torque.
import type { Vec3 } from '../../../core/types';
import { clamp } from '../math';
import { GRAVITY } from '../sense';
import type { P2 } from '../support';

/** Tunable (exported for tools/balance-drills.ts sweeps; the worker never changes it). */
export const GYRO_POLICY = {
  damping: 0.06, // b_g / (m·g·z_c), s
  tapeFrom: 0.4, // stored momentum share where the damping starts to taper...
  tapeTo: 0.6, // ...and is gone
  emergencyDeadbandM: 0.004, // CMP shortfall the gyro ignores (the soles' own compliance)
  bleedInsideM: 0.03, // DCM this deep inside the support before the rotor may bleed
  bleedS: 1.2,
  bleedMarginM: 0.015, // COP shift kept back when sizing the bleed torque
  bleedFadeS: 0.08, // the bleed fades in after a touchdown and out before a lift-off over this long
};

export interface GyroCommand {
  demand: Vec3; // world torque wanted from the core
  bleedS: number; // desaturation time constant (Infinity: no bleed)
  bleedMaxNm: number;
}

export function newGyroCommand(): GyroCommand {
  return { demand: [0, 0, 0], bleedS: Infinity, bleedMaxNm: 0 };
}

/**
 * `shortfall`: CMP shift (world, m) the soles could not deliver. `saturation`: the rotor's fill
 * (0..1). `inside`: how deep the DCM sits inside the support (m, negative outside). `torsoOmega`:
 * world angular velocity of the torso. `bleedShare`: 0..1, how much of the bleed the soles may carry
 * now (two feet down; it fades in and out around the steps, so the COP that carries it never jumps).
 */
export function gyroPolicy(mass: number, comZ: number, torsoOmega: Vec3, shortfall: P2, saturation: number, inside: number, bleedShare: number, out: GyroCommand): GyroCommand {
  const mg = mass * GRAVITY;
  const P = GYRO_POLICY;
  const bg = P.damping * mg * Math.max(0.3, comZ);
  const taper = clamp((P.tapeTo - saturation) / (P.tapeTo - P.tapeFrom), 0, 1);
  let ex = shortfall[0], ey = shortfall[1];
  const n = Math.hypot(ex, ey);
  if (n <= P.emergencyDeadbandM) ex = ey = 0;
  else {
    const k = (n - P.emergencyDeadbandM) / n;
    ex *= k;
    ey *= k;
  }
  // CMP shift Δ ⇒ couple m·g·(Δy, −Δx, 0).
  out.demand[0] = mg * ey - taper * bg * torsoOmega[0];
  out.demand[1] = -mg * ex - taper * bg * torsoOmega[1];
  out.demand[2] = 0;
  if (bleedShare > 0 && inside >= P.bleedInsideM) {
    out.bleedS = P.bleedS;
    out.bleedMaxNm = bleedShare * mg * Math.max(0, inside - P.bleedMarginM);
  } else {
    out.bleedS = Infinity;
    out.bleedMaxNm = 0;
  }
  return out;
}
