// Step placement and timing, every tick (docs/design/balance-engine.md §3.5).
//   in the air   While the soles can deliver the feedback CMP, the DCM error decays and the
//                landing stays where the plan put it. Once the stance sole saturates, the error
//                along the saturated direction n grows as e(t) = Δ + (e₀ − Δ)·e^{ωt} (Δ: the
//                correction the sole still gives along n; across n the feedback still works and the
//                error decays at k_p; and while the error is still inside what the sole's full
//                correction holds, it shrinks), so the landing moves by the error predicted at touchdown,
//                u* = u_nom + e(t_rem), keeping the plan's DCM offset b = ξ_eos − u_nom. If the
//                reach set (the leg from where its hip will be then, the stance sole, the fence)
//                cuts it, the foot lands sooner: the latest touchdown t' ≥ T_min whose predicted
//                landing the reach set holds (Griffin 2017: step adjustment plus speed-up). Frozen
//                for the last 15% of a swing.
//   on two feet  A capture step starts once the DCM is 2 cm outside the support and neither the
//                soles nor the gyro can bring it back within 1/ω₀ (Koolen's capture regions with a
//                finite foot and a reaction mass); the step goes where the DCM will be, from the foot
//                that can reach, timed so the hip can fly the leg there (a swing planned faster than
//                the leg lands short, and the next capture step starts from further behind).
import { APOTHEM } from '../../../core/arena-spec';
import { other, type Gait } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { clamp } from '../math';
import type { Sense } from '../sense';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from '../support';
import { constrainFrom, FOOTWORK_TUNING, minSwingTime, type LegDrive } from './footsteps';
import type { Swing } from './swing';

/** Tunable (tools sweep it; the worker never changes it). */
export const STEP_ADJUST = {
  deadbandM: 0.01, // landing moves smaller than this are ignored
  minSwingW: 0.5, // T_min ≥ this / ω₀ ...
  minSwingS: 0.14, // ... and this
  fenceM: 0.9, // landings stay this far inside the cage
  captureOutM: 0.02, // DCM this far outside the support before a capture step (double support)
  captureSwingW: 0.75, // capture swing, × 1/ω₀ (longer when the leg cannot fly the step that fast)
  captureDriveShare: 0.9, // a capture swing may use this share of the hip's stall torque and speed
  captureMaxW: 1.1, // ...but never lasts longer than this × 1/ω₀ (a weak hip lands a short step
  //                   early rather than a full one too late: the DCM grows e^{ωT} meanwhile)
  captureOvershootM: 0.05,
  captureMaxL: 0.7, // × leg length from the stance sole
  saturatedM: 0.005, // the soles fall this far short of the feedback CMP: saturated
  hurryMissM: 0.03, // the reach set misses the wanted landing by this much: land sooner
};

export interface AdjustInput {
  time: number;
  omega: number;
  /** The feedback's decay rate while the soles deliver it (k_p, 1/s). */
  decay: number;
  /** Where the swing leg's hip will be `t` seconds from now (world, horizontal), and how far from
   *  it (horizontally) the landing sole may be at the stance height. */
  hipAt: (t: number) => P2;
  hipReach: number;
  xi: P2;
  xiRef: P2;
  /** The plan's ξ at the planned touchdown and its landing (their difference is the offset b). */
  xiLand: P2;
  landNom: FootPlace;
  /** The CMP correction the stance sole delivers now (clamped COP − planned CMP). */
  avail: P2;
  /** What the soles fall short of the feedback CMP by (commanded CMP − COP). */
  short: P2;
}

/** Keeps a landing inside the cage. */
function insideFence(p: FootPlace): FootPlace {
  const lim = APOTHEM - STEP_ADJUST.fenceM;
  const r = Math.hypot(p.x, p.y);
  if (r <= lim) return p;
  return { x: (p.x * lim) / r, y: (p.y * lim) / r, yaw: p.yaw };
}

/** Keeps a landing where the leg can put it from where its hip will be (a straight leg aimed past
 *  that reach lifts the foot off the canvas instead). */
function withinHip(p: FootPlace, hip: P2, reach: number): FootPlace {
  const dx = p.x - hip[0], dy = p.y - hip[1];
  const d = Math.hypot(dx, dy);
  if (d <= reach) return p;
  return { x: hip[0] + (dx * reach) / d, y: hip[1] + (dy * reach) / d, yaw: p.yaw };
}

/**
 * Mid-swing landing adjustment. Returns true when the landing (or its timing) was changed.
 * `stance`: the planted sole the body pivots on.
 */
export function adjustSwing(geo: HumanoidGeometry, gait: Gait, swing: Swing, side: Side, a: AdjustInput): boolean {
  const sat = Math.hypot(a.short[0], a.short[1]);
  if (!swing.adjustable(a.time) || sat < STEP_ADJUST.saturatedM) return false;
  const st = gait.feet[other(side)].place;
  const w = a.omega;
  const tRem = Math.max(0.02, swing.remaining(a.time));
  const nx = a.short[0] / sat, ny = a.short[1] / sat;
  const ex0 = a.xi[0] - a.xiRef[0], ey0 = a.xi[1] - a.xiRef[1];
  const e0n = ex0 * nx + ey0 * ny, dn = a.avail[0] * nx + a.avail[1] * ny;
  const px = ex0 - e0n * nx, py = ey0 - e0n * ny;
  // ė = ω(e − Δ) along n: the error runs away only once it is past what the sole's full correction
  // holds; short of that the sole is still taking it back, and the feedback will ease off.
  const runaway = e0n > dn;
  const predict = (t: number): P2 => {
    const k = Math.exp(-a.decay * t);
    const en = runaway ? dn + (e0n - dn) * Math.exp(w * t) : e0n * k;
    return [en * nx + px * k, en * ny + py * k];
  };
  if (!runaway) return false;
  const reach = FOOTWORK_TUNING.maxSepL * geo.legLength;
  const land = (t: number, e: P2, shortfall: P2): FootPlace => insideFence(withinHip(constrainFrom(geo, st, side, {
    x: a.landNom.x + e[0] - shortfall[0], y: a.landNom.y + e[1] - shortfall[1], yaw: a.landNom.yaw,
  }, reach), a.hipAt(t), a.hipReach));
  const e = predict(tRem);
  let target = land(tRem, e, [0, 0]);
  const miss = Math.hypot(a.landNom.x + e[0] - target.x, a.landNom.y + e[1] - target.y);
  if (miss > STEP_ADJUST.hurryMissM) {
    // The reach set bites: land sooner, as late as the reach set still catches it.
    const tMin = Math.max(STEP_ADJUST.minSwingW / w, STEP_ADJUST.minSwingS) - (a.time - swing.t0);
    const lo = Math.max(0.03, tMin);
    if (lo < tRem) {
      // Landing sooner, the plan's own ξ has not travelled as far: the nominal landing comes back
      // by the DCM the plan still had to go (ξ_land − ξ_ref now, scaled by the time left). The
      // latest touchdown that catches it wins; failing that, the one that misses least (landing
      // sooner also leaves the hip further back, so it is no cure for a landing out of reach).
      let best = tRem;
      let bestMiss = miss;
      for (let k = 1; k <= 6; k++) {
        const t = tRem - ((tRem - lo) * k) / 6;
        const ek = predict(t);
        const back = 1 - t / tRem;
        const short: P2 = [(a.xiLand[0] - a.xiRef[0]) * back, (a.xiLand[1] - a.xiRef[1]) * back];
        const tk = land(t, ek, short);
        const mk = Math.hypot(a.landNom.x + ek[0] - short[0] - tk.x, a.landNom.y + ek[1] - short[1] - tk.y);
        if (mk < bestMiss - STEP_ADJUST.deadbandM) {
          best = t;
          bestMiss = mk;
          target = tk;
        }
        if (mk <= STEP_ADJUST.deadbandM) break;
      }
      if (best < tRem) swing.hurry(a.time, best);
    }
  }
  if (Math.hypot(target.x - swing.target.x, target.y - swing.target.y) < STEP_ADJUST.deadbandM * 0.5) return false;
  swing.retarget(a.time, target);
  return true;
}

/**
 * A capture step in the air follows the DCM: the landing moves to where the DCM (pivoting on the
 * stance sole) will be at touchdown, plus the overshoot, within the leg's reach. It is never
 * hurried: it was already timed as fast as the leg can fly. Returns true when it moved.
 */
export function followCapture(geo: HumanoidGeometry, gait: Gait, swing: Swing, side: Side, xi: P2, omega: number, time: number): boolean {
  if (!swing.adjustable(time)) return false;
  const stance = other(side);
  const st = gait.feet[stance].place;
  const sole = footCorners(geo, stance, st, 0.015);
  const { d, closest } = polygonDistance(sole, xi);
  if (d <= 0) return false;
  const k = Math.exp(omega * Math.max(0, swing.remaining(time)));
  const dx = (xi[0] - closest[0]) * k, dy = (xi[1] - closest[1]) * k;
  const n = Math.hypot(dx, dy) || 1e-6;
  const reach = Math.min(n + STEP_ADJUST.captureOvershootM, STEP_ADJUST.captureMaxL * geo.legLength);
  const want: FootPlace = { x: closest[0] + (dx / n) * reach, y: closest[1] + (dy / n) * reach, yaw: swing.target.yaw };
  const place = insideFence(constrainFrom(geo, st, side, want, STEP_ADJUST.captureMaxL * geo.legLength));
  if (Math.hypot(place.x - swing.target.x, place.y - swing.target.y) < 2 * STEP_ADJUST.deadbandM) return false;
  swing.retarget(time, place);
  return true;
}

export interface CapturePlan {
  side: Side;
  place: FootPlace;
  swing: number;
  cmp: P2; // where the stance sole holds the CMP while the foot is up
}

/**
 * Double support: does the DCM need a capture step? `gyroReach`: how far past the soles the
 * gyro can still carry the CMP (m). Returns the step to take, or null.
 */
export function captureStep(geo: HumanoidGeometry, gait: Gait, s: Sense, gyroReach: number, drive: LegDrive, force = false): CapturePlan | null {
  if (gait.phase !== 'double' || !gait.bothPlanted()) return null;
  const xi: P2 = [s.capture[0], s.capture[1]];
  const support = gait.supportPolygon();
  if (support.length < 3) return null;
  const { d } = polygonDistance(support, xi);
  // (`force`: the gyro has been given its chance already: a stalled lift with the DCM outside.)
  if (d < STEP_ADJUST.captureOutM || (!force && d < gyroReach * 0.5)) return null;
  const w = s.omega0;
  const T0 = STEP_ADJUST.captureSwingW / w;
  let best: CapturePlan | null = null;
  let bestMiss = Infinity;
  for (const side of ['l', 'r'] as const) {
    const stance = other(side);
    const sole = footCorners(geo, stance, gait.feet[stance].place, 0.015);
    const { closest } = polygonDistance(sole, xi);
    const from = gait.feet[side].place;
    // The step and its swing time together: the landing where the DCM will be when the foot is
    // down, the swing no shorter than the leg can fly that far.
    let T = T0;
    let pred: P2 = [xi[0], xi[1]];
    let place: FootPlace = from;
    for (let it = 0; it < 3; it++) {
      const k = Math.exp(w * T);
      pred = [closest[0] + (xi[0] - closest[0]) * k, closest[1] + (xi[1] - closest[1]) * k];
      const dx = pred[0] - closest[0], dy = pred[1] - closest[1];
      const n = Math.hypot(dx, dy) || 1e-6;
      const reach = Math.min(n + STEP_ADJUST.captureOvershootM, STEP_ADJUST.captureMaxL * geo.legLength);
      const want: FootPlace = { x: closest[0] + (dx / n) * reach, y: closest[1] + (dy / n) * reach, yaw: from.yaw };
      place = insideFence(constrainFrom(geo, gait.feet[stance].place, side, want, STEP_ADJUST.captureMaxL * geo.legLength));
      const need = minSwingTime(drive, Math.hypot(place.x - from.x, place.y - from.y), geo.legLength, STEP_ADJUST.captureDriveShare);
      const next = clamp(Math.max(T0, need), STEP_ADJUST.minSwingS, STEP_ADJUST.captureMaxW / w);
      if (Math.abs(next - T) < 0.005) break;
      T = next;
    }
    const hull = convexHull([...sole, ...footCorners(geo, side, place, 0)]);
    const miss = polygonDistance(hull, pred).d;
    // The unloaded foot (farther from the DCM) is preferred unless the other captures clearly better.
    const far = Math.hypot(gait.feet[side].place.x - xi[0], gait.feet[side].place.y - xi[1]);
    const score = miss - 0.02 * far;
    if (score < bestMiss) {
      bestMiss = score;
      best = { side, place, swing: T, cmp: [closest[0], closest[1]] };
    }
  }
  return best;
}
