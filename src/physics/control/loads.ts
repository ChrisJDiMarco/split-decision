// How the body's weight is shared between the feet, where each sole presses, and whether a
// loaded sole is rolling onto its edge.
import type { Vec3 } from '../../core/types';
import type { FootLoad } from './feedforward';
import type { Gait } from './gait';
import { SIDES, type HumanoidGeometry, type Side } from './geometry';
import { clamp, wrapAngle } from './math';
import type { Sense } from './sense';
import { clampToPolygon, footCorners, type P2 } from './support';

const COP_MARGIN = 0.01; // m inside the sole edge

/**
 * Splits body weight between the planted feet so their combined centre of pressure is `cop`;
 * each foot's centre of pressure is clamped to what that sole can physically deliver.
 */
export function footLoads(geo: HumanoidGeometry, gait: Gait, s: Sense, cop: P2): Record<Side, FootLoad> {
  const L = s.feet.l.sole, R = s.feet.r.sole;
  const lp = gait.planted('l'), rp = gait.planted('r');
  if (!lp && !rp) return { l: { share: 0, cop: L }, r: { share: 0, cop: R } };
  const onFoot = (side: Side, q: P2): Vec3 => {
    const c = clampToPolygon(footCorners(geo, side, gait.feet[side].place, COP_MARGIN), q);
    return [c[0], c[1], 0];
  };
  if (lp !== rp) {
    const side: Side = lp ? 'l' : 'r';
    const p = onFoot(side, cop);
    return side === 'l' ? { l: { share: 1, cop: p }, r: { share: 0, cop: R } } : { l: { share: 0, cop: L }, r: { share: 1, cop: p } };
  }
  const lc = gait.feet.l.place, rc = gait.feet.r.place;
  const dx = rc.x - lc.x, dy = rc.y - lc.y;
  const len2 = Math.max(1e-6, dx * dx + dy * dy);
  const t = clamp(((cop[0] - lc.x) * dx + (cop[1] - lc.y) * dy) / len2, 0, 1);
  const offX = cop[0] - (lc.x + dx * t), offY = cop[1] - (lc.y + dy * t);
  return {
    l: { share: 1 - t, cop: onFoot('l', [lc.x + offX, lc.y + offY]) },
    r: { share: t, cop: onFoot('r', [rc.x + offX, rc.y + offY]) },
  };
}

/**
 * Rotation (world x, y) that would lay the soles flat again, weighted by the load each carries:
 * a foot being unloaded before a step peels off harmlessly, while a sole carrying the body and
 * rolling onto its edge means the robot is pivoting over it.
 */
export function soleRoll(gait: Gait, s: Sense, loads: Record<Side, FootLoad>): P2 {
  const out: P2 = [0, 0];
  for (const side of SIDES) {
    if (!gait.planted(side)) continue;
    const R = s.feet[side].rot;
    const w = loads[side].share;
    out[0] += w * R[5]; // sole up-axis × ẑ
    out[1] -= w * R[2];
  }
  return out;
}

/** Pelvis yaw kept inside what the hip yaw joints allow relative to each planted foot. */
export function reachablePelvisYaw(geo: HumanoidGeometry, gait: Gait, want: number): number {
  let y = want;
  for (const side of SIDES) {
    const f = gait.feet[side];
    if (f.phase !== 'planted') continue;
    const lim = geo.limits.get(`hip_yaw_${side}`)!;
    // hip_yaw = footYaw − pelvisYaw ∈ [lo, hi]  ⇒  pelvisYaw ∈ [footYaw − hi, footYaw − lo]
    const rel = wrapAngle(y - f.place.yaw);
    y = f.place.yaw + clamp(rel, -lim.hi + 0.05, -lim.lo - 0.05);
  }
  return y;
}
