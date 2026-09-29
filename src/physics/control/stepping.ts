// Step decisions on top of the gait:
//   planned   feet chase their slots in a desired stance frame (advance, retreat, circle, turn)
//   capture   the capture point left the support polygon: step where it will be at touchdown,
//             ξ(T) = p + (ξ₀ − p)·e^{ω₀T}, measured from the stance foot's centre of pressure
import { other, type Gait, type StanceFrame, type StepTiming } from './gait';
import type { HumanoidGeometry, Side } from './geometry';
import { clamp, lerp, wrapAngle } from './math';
import type { Sense } from './sense';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from './support';

/** How close a foot must be to its slot: tight while travelling, loose while holding ground. */
export interface StepTolerance {
  pos: number; // m
  yaw: number; // rad
}
export const MOVE_TOL: StepTolerance = { pos: 0.05, yaw: 0.18 };
export const HOLD_TOL: StepTolerance = { pos: 0.1, yaw: 0.3 };
// Stance-frame advance per step, fraction of leg length: long strides while the goal is far, short
// ones for the last stretch, so the fighter arrives square and settled (a kick needs that).
const MAX_STRIDE_PER_LEG = 0.22;
const FINE_STRIDE_PER_LEG = 0.12;
const FINE_APPROACH = 0.35; // × leg length: inside this distance of the goal, fine strides only
const COARSE_APPROACH = 0.9; // × leg length: beyond this, full strides
const PLANNED_MAX_SEPARATION = 0.55; // swing sole within this × leg length of the stance sole (with the pelvis dip)
const YAW_WEIGHT = 0.25; // m of progress per radian of turn
const REPEAT_PENALTY = 0.02; // m: prefer alternating feet
const MIN_GAIN = 0.02; // m: a step must close at least this much
const MAX_SWING_TRAVEL = 0.35; // fraction of leg length a foot moves per step (forward)
const MAX_BACK_TRAVEL = 0.45 * MAX_SWING_TRAVEL; // the heel is short: less COP authority backward
const MAX_SIDE_TRAVEL = 0.71 * MAX_SWING_TRAVEL;
const SWING_BASE_S = 0.28; // swing time for a short step
const SWING_PER_M = 0.5; // extra swing time per metre of travel (heavy legs are torque-limited)
const MAX_TURN_PER_STEP = 0.25; // rad
const CAPTURE_MARGIN = 0.02; // m outside the support polygon before a capture step
const CAPTURE_OVERSHOOT = 0.06; // m past the predicted capture point
const MAX_CAPTURE_STEP = 0.75; // fraction of leg length from the stance foot
const ADJUST_MARGIN = 0.02; // m inside the future support before a swing is re-aimed
const CAPTURE_PREFER_M = 0.03; // the loaded foot only steps if it captures this much better
const SKILL_CAPTURE_MARGIN = 0.05; // m outside the stance sole before a kick is abandoned for a step
const HURRY_MARGIN = 0.03; // m outside the stance sole before a slow swing is hurried down...
const HURRY_S = 0.2; // ... to land within this

export const CAPTURE_TIMING: StepTiming = { shift: 0.001, shiftFraction: 0, swing: 0.2, lift: 0.045 };

/** Clamp the desired frame to one stride (and one turn) from where the feet are now. */
export function limitFrame(cur: StanceFrame, want: StanceFrame, legLength: number): StanceFrame {
  const dx = want.x - cur.x, dy = want.y - cur.y;
  const d = Math.hypot(dx, dy);
  const far = clamp((d / legLength - FINE_APPROACH) / (COARSE_APPROACH - FINE_APPROACH), 0, 1);
  const maxD = lerp(FINE_STRIDE_PER_LEG, MAX_STRIDE_PER_LEG, far) * legLength;
  const k = d > maxD ? maxD / d : 1;
  const dyaw = clamp(wrapAngle(want.heading - cur.heading), -MAX_TURN_PER_STEP, MAX_TURN_PER_STEP);
  return { x: cur.x + dx * k, y: cur.y + dy * k, heading: cur.heading + dyaw };
}

function footError(a: FootPlace, b: FootPlace): { d: number; yaw: number } {
  return { d: Math.hypot(a.x - b.x, a.y - b.y), yaw: Math.abs(wrapAngle(a.yaw - b.yaw)) };
}

/**
 * Start the next planned step toward `want`, if one is due. Both feet are candidates; each
 * target is clipped to what the leg can reach while the COM sits over the other foot, and the
 * foot that closes the most distance steps (so a staggered stance advances rear-foot first,
 * the way boxers do). Returns the side stepping, or null.
 */
export function planStep(gait: Gait, geo: HumanoidGeometry, want: StanceFrame, timing: StepTiming, lastSide: Side | null, tol: StepTolerance): Side | null {
  if (gait.phase !== 'double' || !gait.bothPlanted()) return null;
  const cur = gait.currentFrame();
  const goal = limitFrame(cur, want, geo.legLength);
  let best: { side: Side; target: FootPlace; gain: number } | null = null;
  for (const side of ['l', 'r'] as const) {
    const slot = gait.slot(side, goal);
    const err = footError(slot, gait.feet[side].place);
    if (err.d <= tol.pos && err.yaw <= tol.yaw) continue;
    const from = gait.feet[side].place;
    const target = limitTravel(from, gait.constrainTarget(side, slot, PLANNED_MAX_SEPARATION * geo.legLength), travelLimit(from, slot, cur.heading, geo.legLength));
    const left = footError(slot, target);
    const gain = err.d - left.d + YAW_WEIGHT * (err.yaw - left.yaw) - (side === lastSide ? REPEAT_PENALTY : 0);
    if (gain > MIN_GAIN && (!best || gain > best.gain)) best = { side, target, gain };
  }
  if (!best) return null;
  const travel = Math.hypot(best.target.x - gait.feet[best.side].place.x, best.target.y - gait.feet[best.side].place.y);
  const swing = Math.max(timing.swing, SWING_BASE_S + SWING_PER_M * travel);
  // Travelling, the body walks (lifts off on a capturable step); settling into place it shifts
  // its weight over the stance foot first.
  const dynamic = Math.hypot(want.x - cur.x, want.y - cur.y) > FINE_APPROACH * geo.legLength;
  return gait.step(best.side, best.target, { ...timing, swing, dynamic }) ? best.side : null;
}

/** Longest step toward `to`: full length forward, shorter backward and sideways (a swing
 *  behind the body, or across it, is harder to balance and the hips have less range). */
function travelLimit(from: FootPlace, to: FootPlace, heading: number, legLength: number): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return MAX_SWING_TRAVEL * legLength;
  const along = (dx * Math.cos(heading) + dy * Math.sin(heading)) / d; // +1 forward, −1 backward
  const frac = along >= 0 ? lerp(MAX_SIDE_TRAVEL, MAX_SWING_TRAVEL, along) : lerp(MAX_SIDE_TRAVEL, MAX_BACK_TRAVEL, -along);
  return frac * legLength;
}

/** A heavy leg can only swing so far in one step. */
function limitTravel(from: FootPlace, to: FootPlace, max: number): FootPlace {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d <= max) return to;
  const k = max / d;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, yaw: to.yaw };
}

/** Where the capture point will be after `t` seconds pivoting over `pivot`. */
export function predictCapture(s: Sense, pivot: P2, t: number): P2 {
  const k = Math.exp(s.omega0 * t);
  return [pivot[0] + (s.capture[0] - pivot[0]) * k, pivot[1] + (s.capture[1] - pivot[1]) * k];
}

/**
 * Capture step: when the capture point is outside the support, step to where it will be. A
 * weight shift in progress is abandoned first: the fall takes priority over the plan.
 *
 * The unloaded foot (farther from the capture point) steps when it can reach; when the body is
 * falling out past the near foot, that foot cannot be crossed over, so the near foot itself
 * steps out: it is lifted loaded and the body pivots on the other sole until it lands.
 */
export function captureStep(gait: Gait, geo: HumanoidGeometry, s: Sense): Side | null {
  if ((gait.phase !== 'double' && gait.phase !== 'shift') || !gait.bothPlanted()) return null;
  const cap: P2 = [s.capture[0], s.capture[1]];
  if (gait.supportDistance(cap) < CAPTURE_MARGIN) return null;
  gait.cancelShift();
  const dist = (side: Side) => Math.hypot(gait.feet[side].place.x - cap[0], gait.feet[side].place.y - cap[1]);
  const far: Side = dist('l') > dist('r') ? 'l' : 'r';
  const first = capturePlan(gait, geo, s, far);
  const plan = first.miss <= 0 ? first : [first, capturePlan(gait, geo, s, other(far))].reduce((a, b) => (b.miss < a.miss - CAPTURE_PREFER_M ? b : a));
  return gait.step(plan.side, plan.place, CAPTURE_TIMING) ? plan.side : null;
}

/** Where `side` would step to capture, and how far the capture point would still be outside. */
function capturePlan(gait: Gait, geo: HumanoidGeometry, s: Sense, side: Side): { side: Side; place: FootPlace; miss: number } {
  const stance = other(side);
  const sole = footCorners(geo, stance, gait.feet[stance].place, 0);
  const pivot = polygonDistance(sole, [s.capture[0], s.capture[1]]).closest;
  const target = captureTarget(geo, s, pivot, CAPTURE_TIMING.swing);
  const place = gait.constrainTarget(side, { x: target[0], y: target[1], yaw: gait.feet[side].place.yaw }, MAX_CAPTURE_STEP * geo.legLength);
  const pred = predictCapture(s, pivot, CAPTURE_TIMING.swing);
  const hull = convexHull([...sole, ...footCorners(geo, side, place, 0)]);
  return { side, place, miss: polygonDistance(hull, pred).d };
}

/**
 * A kick that has thrown the body off its stance sole (a blocked kick, the recoil off a heavy
 * target): the kicking leg comes down where the capture point is heading instead of finishing
 * the kick. Returns true when the leg was reclaimed; the caller ends the skill.
 */
export function skillCaptureStep(gait: Gait, geo: HumanoidGeometry, s: Sense): boolean {
  const side = gait.skillLegActive();
  if (!side || gait.feet[side].phase !== 'skill') return false;
  const stance = other(side);
  const sole = footCorners(geo, stance, gait.feet[stance].place, 0);
  const { d, closest } = polygonDistance(sole, [s.capture[0], s.capture[1]]);
  if (d < SKILL_CAPTURE_MARGIN) return false;
  const target = captureTarget(geo, s, closest, CAPTURE_TIMING.swing);
  gait.returnSkillLeg({ x: target[0], y: target[1], yaw: gait.feet[stance].place.yaw }, CAPTURE_TIMING, s);
  return true;
}

export function captureTarget(geo: HumanoidGeometry, s: Sense, pivot: P2, swing: number): P2 {
  const pred = predictCapture(s, pivot, swing);
  let dx = pred[0] - pivot[0], dy = pred[1] - pivot[1];
  const d = Math.hypot(dx, dy) || 1e-6;
  const reach = Math.min(d + CAPTURE_OVERSHOOT, MAX_CAPTURE_STEP * geo.legLength);
  dx *= reach / d;
  dy *= reach / d;
  return [pivot[0] + dx, pivot[1] + dy];
}

/**
 * Mid-swing: if the capture point predicted at touchdown will not be inside the support the
 * landing creates (stance sole + landing sole), slide the landing toward it until it is. A
 * normal step (capture point over the stance sole) is left alone.
 */
export function adjustSwing(gait: Gait, geo: HumanoidGeometry, s: Sense): void {
  if (gait.phase !== 'single' || !gait.swingSide) return;
  const side = gait.swingSide;
  const f = gait.feet[side];
  const st = gait.feet[other(side)].place;
  // The stance ankle holds the centre of pressure anywhere on its sole, so the capture point
  // only diverges from the nearest point of that sole; inside it, nothing diverges at all.
  const sole = footCorners(geo, other(side), st, 0);
  const { d: out, closest: pivot } = polygonDistance(sole, [s.capture[0], s.capture[1]]);
  if (out <= 0) return;
  // The body is already tipping off the stance sole: this foot must land now, not on schedule.
  if (out > HURRY_MARGIN) gait.hurrySwing(HURRY_S);
  const remaining = Math.max(0.02, f.dur - f.t);
  const pred = predictCapture(s, pivot, remaining);
  const hull = convexHull([...sole, ...footCorners(geo, side, f.target, ADJUST_MARGIN)]);
  const { d, closest } = polygonDistance(hull, pred);
  if (d <= 0) return;
  // Move the landing sole by the shortfall, along the gap, within the capture reach.
  const moved: FootPlace = { x: f.target.x + pred[0] - closest[0], y: f.target.y + pred[1] - closest[1], yaw: f.target.yaw };
  f.target = gait.constrainTarget(side, moved, MAX_CAPTURE_STEP * geo.legLength);
}
