// Can the body follow a footstep plan from where it is now? A short rollout of the linear inverted
// pendulum under the engine's own feedback law, with the CMP clipped into the soles the plan stands
// on at each moment (no gyro, no step adjustment: a plan that needs either is not a plan to pick).
//   ξ = c + ċ/ω,  r = r_ref + g·(ξ − ξ_ref) clipped into the support,  c̈ = ω²(c − r)
// On two feet, right after a touchdown, the pressure is on the foot that just landed (measured: these
// position-servoed legs take the impact on the landing leg and the centre of pressure jumps to that
// sole within 10 ms whatever the plan asks; it follows the command again on that sole and, once the
// landing has settled (`settleS`), over both). A plan that needs a push off the other foot then
// stalls, and so does it here. The CMP is also kept within `dsReach` of the COM on two feet.
// The mocap pick (balance/mocap-steps.ts) keeps a clip's steps only when the DCM error this rollout
// predicts stays as small as the procedural plan's ("keep only matches whose footsteps pass
// step-adjust", docs/design/balance-engine.md). Allocation free.
import { other } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { clampToPolygon, convexHull, footCorners, type FootPlace, type P2 } from '../support';
import { newDcmSample, type DcmPlan } from './dcm';
import type { Footstep } from './types';

export interface RolloutResult {
  /** Largest DCM error against the plan (m) over the rollout. */
  maxErr: number;
  /** Largest DCM error at a planned touchdown (m). */
  landErr: number;
  /** Seconds the soles could not deliver the feedback CMP (more than 5 mm short). */
  saturated: number;
}

export function newRolloutResult(): RolloutResult {
  return { maxErr: 0, landErr: 0, saturated: 0 };
}

const sample = newDcmSample();

/**
 * Rolls the body (COM `c0`, velocity `v0`) along `plan` from `t0` for `horizon` seconds in steps of
 * `h`, standing on the feet `feet` (a foot in the air lands at `swing.land` on `swing.place`) and
 * then on the footsteps `steps[0..count)` as they lift and land. `gain` is the feedback's 1 + k_p/ω.
 */
export function rollout(
  geo: HumanoidGeometry, plan: DcmPlan, steps: readonly Footstep[], count: number,
  feet: Record<Side, FootPlace>, swing: { side: Side; land: number; place: FootPlace } | null,
  c0: readonly number[], v0: readonly number[], omega: number, gain: number, t0: number, horizon: number, h: number, shrink: number,
  dsReach: number, landed: Side | null, settleS: number, out: RolloutResult,
): RolloutResult {
  const place: Record<Side, FootPlace> = { l: feet.l, r: feet.r };
  let up: Side | null = swing ? swing.side : null;
  let upLand = swing ? swing.land : -Infinity;
  let upPlace: FootPlace | null = swing ? swing.place : null;
  let next = 0;
  let last: Side | null = landed;
  let landedAt = t0;
  let cx = c0[0], cy = c0[1], vx = v0[0], vy = v0[1];
  const w2 = omega * omega;
  let poly: [number, number][] = support(geo, place, up ?? (last ? other(last) : null), shrink);
  out.maxErr = 0;
  out.landErr = 0;
  out.saturated = 0;
  const n = Math.max(1, Math.round(horizon / h));
  for (let i = 0; i < n; i++) {
    const t = t0 + i * h;
    // Contact events: the foot in the air lands, the next planned one lifts.
    let changed = false;
    if (up && t >= upLand) {
      place[up] = upPlace!;
      last = up;
      landedAt = t;
      up = null;
      changed = true;
    }
    if (last && !up && t - landedAt >= settleS) {
      last = null;
      changed = true;
    }
    if (!up && next < count && t >= steps[next].lift) {
      const s = steps[next++];
      up = s.side;
      upLand = s.land;
      upPlace = s.place;
      changed = true;
    }
    if (changed) poly = support(geo, place, up ?? (last ? other(last) : null), shrink);
    plan.sample(t, sample);
    const xx = cx + vx / omega, xy = cy + vy / omega;
    const ex = xx - sample.xi[0], ey = xy - sample.xi[1];
    const err = Math.hypot(ex, ey);
    if (err > out.maxErr) out.maxErr = err;
    if (changed && !up && err > out.landErr) out.landErr = err;
    const rx = sample.r[0] + gain * ex, ry = sample.r[1] + gain * ey;
    let r = poly.length >= 3 ? clampToPolygon(poly, [rx, ry]) : [rx, ry];
    if (!up && !last) {
      const dx = r[0] - cx, dy = r[1] - cy;
      const d = Math.hypot(dx, dy);
      if (d > dsReach) {
        const p: [number, number] = [cx + (dx * dsReach) / d, cy + (dy * dsReach) / d];
        r = poly.length >= 3 ? clampToPolygon(poly, p) : p;
      }
    }
    if (Math.hypot(r[0] - rx, r[1] - ry) > 0.005) out.saturated += h;
    const ax = w2 * (cx - r[0]), ay = w2 * (cy - r[1]);
    vx += ax * h;
    vy += ay * h;
    cx += vx * h;
    cy += vy * h;
  }
  return out;
}

/** The soles that can take the CMP: the stance sole in single support, both on two feet. */
function support(geo: HumanoidGeometry, place: Record<Side, FootPlace>, up: Side | null, shrink: number): [number, number][] {
  if (up) return footCorners(geo, other(up), place[other(up)], shrink);
  return convexHull([...footCorners(geo, 'l', place.l, shrink), ...footCorners(geo, 'r', place.r, shrink)]);
}

export type { P2 };
