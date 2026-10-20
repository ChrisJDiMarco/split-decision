// Hip kinematics for both NEXT GEN layouts, and a range-limited numeric IK used for the Phase 0
// pose fits (docs/research/10-engineai-fighters.md §5 method: thigh-direction error + knee-axis error).
//   stock  (iron, modern, variants A R M): pelvis → yaw (z) → roll (x) → pitch (y), one point.
//   tilted (variants O P P′): pelvis → pitch about (0, cos15°, ∓sin15°) → roll (x) → yaw (thigh z).
// Joint angles are MuJoCo joint angles (radians), side-specific (the right side's roll and yaw
// ranges are the mirror of the left's).
import { DEG, angle, apply, mulAll, rAxis, rotAngle, rx, ry, rz, type M3, type V3 } from './math3';

export type Layout = 'stock' | 'tilted';
export type Side = 'l' | 'r';
export const TILT = 15 * DEG;

/** The tilted layout's pitch axis for one side (left: outer end down = (0, cos, −sin)). */
export const pitchAxis = (side: Side): V3 => [0, Math.cos(TILT), side === 'l' ? -Math.sin(TILT) : Math.sin(TILT)];

export interface HipAngles { p: number; r: number; y: number }

/** Thigh-frame rotation relative to the pelvis. */
export function fkHip(layout: Layout, side: Side, q: HipAngles): M3 {
  return layout === 'stock' ? mulAll(rz(q.y), rx(q.r), ry(q.p)) : mulAll(rAxis(pitchAxis(side), q.p), rx(q.r), rz(q.y));
}

export interface HipRanges { p: [number, number]; r: [number, number]; y: [number, number] } // radians, this side

/** Thigh direction (the leg hangs along −z) and knee axis (+y) for a hip rotation. */
export const thighDir = (R: M3): V3 => apply(R, [0, 0, -1]);
export const kneeAxis = (R: M3): V3 => apply(R, [0, 1, 0]);

export type HipCost = (R: M3, q: HipAngles) => number;

/** Kick-pose cost: thigh-direction error + knee-axis error (radians), as research §5. */
export const kickCost = (d: V3, k: V3): HipCost => (R) => angle(thighDir(R), d) + angle(kneeAxis(R), k);
/** Full-orientation cost (pivots). */
export const rotCost = (target: M3): HipCost => (R) => rotAngle(R, target);

const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));

/**
 * Best hip angles inside the ranges: a 3° grid over the whole range box, then a shrinking pattern
 * search from the best few grid points. Deterministic.
 */
export function solveHip(layout: Layout, side: Side, ranges: HipRanges, cost: HipCost, gridDeg = 3): { q: HipAngles; cost: number } {
  const g = gridDeg * DEG;
  const axis = (r: [number, number]) => { const out: number[] = []; for (let x = r[0]; x <= r[1] + 1e-9; x += g) out.push(x); if (out[out.length - 1] < r[1] - 1e-9) out.push(r[1]); return out; };
  const P = axis(ranges.p), Rr = axis(ranges.r), Y = axis(ranges.y);
  const best: Array<{ q: HipAngles; c: number }> = [];
  for (const p of P) for (const r of Rr) for (const y of Y) {
    const q = { p, r, y };
    const c = cost(fkHip(layout, side, q), q);
    if (best.length < 6 || c < best[best.length - 1].c) {
      best.push({ q, c });
      best.sort((a, b) => a.c - b.c);
      if (best.length > 6) best.pop();
    }
  }
  let out = best[0];
  for (const start of best) {
    let q = { ...start.q }, c = start.c, step = g;
    while (step > 0.01 * DEG) {
      let improved = false;
      for (const key of ['p', 'r', 'y'] as const) {
        for (const sgn of [1, -1]) {
          const n = { ...q, [key]: clamp(q[key] + sgn * step, ranges[key]) };
          const nc = cost(fkHip(layout, side, n), n);
          if (nc < c - 1e-12) { q = n; c = nc; improved = true; }
        }
      }
      if (!improved) step /= 2;
    }
    if (c < out.c) out = { q, c };
  }
  return { q: out.q, cost: out.c };
}

/** Range in radians for one side from a left-side degree range (roll and yaw mirror). */
export function sideRange(side: Side, leftDeg: [number, number], mirror: boolean): [number, number] {
  const [lo, hi] = side === 'l' || !mirror ? leftDeg : [-leftDeg[1], -leftDeg[0]];
  return [lo * DEG, hi * DEG];
}

/**
 * Closed-form hip IK (§4.2): the hip angles that give thigh rotation R, unclamped. Stock: R = Rz(y)·
 * Rx(r)·Ry(p) (ZXY). Tilted: R = Rx(∓15°)·Ry(p)·Rx(r ± 15°)·Rz(y), decomposed as YXZ after
 * pre-multiplying by Rx(±15°). Gimbal lock at stock roll ±90°, tilted roll +75° (left).
 */
export function ikHip(layout: Layout, side: Side, R: M3): HipAngles {
  if (layout === 'stock') {
    // R = Rz(y)Rx(r)Ry(p): row 2 = [−cr·sp, sr, cr·cp]; column 1 = [−sy·cr, cy·cr, sr].
    const r = Math.asin(Math.max(-1, Math.min(1, R[7])));
    return { p: Math.atan2(-R[6], R[8]), r, y: Math.atan2(-R[1], R[4]) };
  }
  const t = side === 'l' ? TILT : -TILT;
  const M = mulAll(rx(t), R);
  const rr = Math.asin(Math.max(-1, Math.min(1, -M[5])));
  return { p: Math.atan2(M[2], M[8]), r: rr - t, y: Math.atan2(M[3], M[4]) };
}

export function clampHip(q: HipAngles, rng: HipRanges): HipAngles {
  const c = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));
  return { p: c(q.p, rng.p), r: c(q.r, rng.r), y: c(q.y, rng.y) };
}
