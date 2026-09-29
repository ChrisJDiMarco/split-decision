// Footwork. Each foot is planted (pose measured at touchdown), swinging on a minimum-jerk arc,
// or lent to a skill (kicks). A step is:
//   shift    the COM reference travels to the stance foot on a quintic (continuous velocity and
//            acceleration), timed so the centre of pressure can actually deliver it: a heavy
//            body only accelerates at about ω²·(COP offset)
//   lift     only once the capture point is inside the stance sole, so single support is
//            capturable (a loaded foot cannot leave the canvas)
//   swing    minimum-jerk arc to the target, solved from the measured pelvis
//   land     planted where it actually touched down; the COM heads for the next support
import type { Vec3 } from '../../core/types';
import { SIDES, type HumanoidGeometry, type Side } from './geometry';
import { clamp, minJerk, rot2, rotZ, wrapAngle } from './math';
import type { LegCommand } from './posture';
import type { Sense } from './sense';
import type { StanceParams } from './stance';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from './support';

export type FootPhase = 'air' | 'planted' | 'swing' | 'skill';
export type GaitPhase = 'double' | 'shift' | 'single' | 'skill';

export interface FootState {
  phase: FootPhase;
  place: FootPlace; // planted pose, or swing start
  target: FootPlace; // swing target
  t: number;
  dur: number;
  lift: number;
  startZ: number; // sole height at the swing start (a leg handed back by a kick is still up)
  lifted: boolean;
}

export interface StanceFrame {
  x: number;
  y: number;
  heading: number;
}

export interface StepTiming {
  shift: number; // max s to wait for a capturable weight shift (0 = lift at once: capture steps)
  shiftFraction: number; // how far the COM goes toward the stance sole, 0..1
  swing: number; // s in the air
  lift: number; // swing apex, m
}

export interface ComRef {
  pos: P2;
  vel: P2;
  acc: P2;
}

const TOUCHDOWN_HEIGHT = 0.006; // m: sole this close to the canvas counts as contact
const LIFTED_HEIGHT = 0.015; // m: the swing foot has really left the canvas
const LATE_LAND_EXTRA_S = 0.12;
const MIN_SHIFT_S = 0.05;
const LIFT_MAX_COM_SPEED = 0.35; // m/s: single support starts from a fairly settled COM
const LIFT_DEPTH = 0.3; // capture point this far into the stance sole (× its half-width) before lift-off
const MIN_FOOT_SEPARATION = 0.2; // fraction of leg length, sole centre to sole centre
const MAX_FOOT_SEPARATION = 0.6; // fraction of leg length, default reach from the stance sole
const MIN_LATERAL_GAP = 0.08; // fraction of leg length: feet never cross
const HIP_YAW_MARGIN = 0.12; // rad kept from the hip yaw limit when turning
const HURRY_MAX_PROGRESS = 0.9; // a swing this far along lands soon enough as it is
const HURRY_MAX_START_Z = 0.1; // m: only ordinary steps (sole near the canvas at lift-off) are hurried
const REANCHOR_ERROR_M = 0.12;
const SLIP_M = 0.02; // a planted sole this far from its recorded pose has slid: re-plant it there
const SLIP_YAW_RAD = 0.05;
const DIP_PER_METRE = 0.3; // pelvis dip per metre of step: a lower hip reaches further
const MAX_DIP_FRACTION = 0.09;
const SWING_TRAVEL_START = 0.12; // fraction of the swing spent lifting before the foot travels
const SWING_TRAVEL_END = 0.88;

/**
 * COM reference that moves like the robot can: the capture point ξ converges exponentially to
 * the goal, ξ̇ = −k·ω·(ξ − goal), and the COM follows it, ċ = ω·(ξ − c) (linear inverted
 * pendulum). The implied centre of pressure ξ + k·(ξ − goal) stays between start and goal, so
 * the plan never asks the soles for more than they have, and neither ξ nor the COM overshoot.
 */
class DcmReference {
  c: P2 = [0, 0];
  xi: P2 = [0, 0];
  goal: P2 = [0, 0];
  k = 1.2;

  reset(c: P2, v: P2, omega: number): void {
    this.c = [c[0], c[1]];
    this.xi = [c[0] + v[0] / omega, c[1] + v[1] / omega];
    this.goal = [c[0], c[1]];
  }

  step(dt: number, omega: number, out: ComRef): void {
    const decay = Math.exp(-this.k * omega * dt);
    for (let i = 0; i < 2; i++) {
      const xi0 = this.xi[i];
      this.xi[i] = this.goal[i] + (xi0 - this.goal[i]) * decay;
      const xiDot = -this.k * omega * (this.xi[i] - this.goal[i]);
      this.c[i] += omega * (this.xi[i] - this.c[i]) * dt;
      const v = omega * (this.xi[i] - this.c[i]);
      out.pos[i] = this.c[i];
      out.vel[i] = v;
      out.acc[i] = omega * (xiDot - v);
    }
  }

  /** Distance of the planned capture point from its goal. */
  remaining(): number {
    return Math.hypot(this.xi[0] - this.goal[0], this.xi[1] - this.goal[1]);
  }
}

export class Gait {
  readonly feet: Record<Side, FootState>;
  phase: GaitPhase = 'double';
  swingSide: Side | null = null;
  shiftT = 0;
  stepsTaken = 0;
  captureSteps = 0;
  abortedShifts = 0;
  /** Convergence of the capture point toward its goal, in units of ω₀ (DCM gain). */
  settleGain = 1.0;
  shiftGain = 1.4;
  /** Planted-ankle blend between posture stiffness (1) and sole-flat compliance (0). */
  plantedAnkleStiffness = 0.7;
  private shiftMax = 0.5;
  private skillSide: Side | null = null;
  private skillReady = false;
  private readonly dcm = new DcmReference();
  private anchored = false;
  readonly ref: ComRef = { pos: [0, 0], vel: [0, 0], acc: [0, 0] };

  constructor(private readonly geo: HumanoidGeometry, private readonly stance: StanceParams) {
    const foot = (): FootState => ({ phase: 'air', place: { x: 0, y: 0, yaw: 0 }, target: { x: 0, y: 0, yaw: 0 }, t: 0, dur: 0.3, lift: 0.05, startZ: 0, lifted: false });
    this.feet = { l: foot(), r: foot() };
  }

  // ---------------------------------------------------------------- queries

  planted(side: Side): boolean {
    return this.feet[side].phase === 'planted';
  }

  bothPlanted(): boolean {
    return this.planted('l') && this.planted('r');
  }

  airborne(): boolean {
    return this.feet.l.phase === 'air' && this.feet.r.phase === 'air';
  }

  /** True while the COM plan is still travelling toward its goal. */
  transferring(): boolean {
    return this.dcm.remaining() > 0.01;
  }

  slot(side: Side, frame: StanceFrame): FootPlace {
    const s = this.stance.slots[side];
    const [dx, dy] = rot2(s.x, s.y, frame.heading);
    return { x: frame.x + dx, y: frame.y + dy, yaw: frame.heading + s.yaw };
  }

  /** The frame the planted feet currently describe (inverse of `slot`). */
  currentFrame(): StanceFrame {
    const l = this.feet.l.place, r = this.feet.r.place;
    const sl = this.stance.slots.l, sr = this.stance.slots.r;
    const a = l.yaw - sl.yaw;
    const heading = wrapAngle(a + wrapAngle(r.yaw - sr.yaw - a) / 2);
    const [ox, oy] = rot2((sl.x + sr.x) / 2, (sl.y + sr.y) / 2, heading);
    return { x: (l.x + r.x) / 2 - ox, y: (l.y + r.y) / 2 - oy, heading };
  }

  /** Support polygon of the feet that bear weight (CCW), optionally shrunk by a margin. */
  supportPolygon(shrink = 0): P2[] {
    const pts: P2[] = [];
    for (const side of SIDES) {
      if (this.feet[side].phase === 'planted') pts.push(...footCorners(this.geo, side, this.feet[side].place, shrink));
    }
    return pts.length >= 3 ? convexHull(pts) : pts;
  }

  /** Signed distance of a point from the (shrunk) support polygon: < 0 inside. */
  supportDistance(p: P2, shrink = 0): number {
    const poly = this.supportPolygon(shrink);
    if (poly.length < 3) return Infinity;
    return polygonDistance(poly, p).d;
  }

  insideFoot(side: Side, p: P2, margin: number): boolean {
    return polygonDistance(footCorners(this.geo, side, this.feet[side].place, margin), p).d <= 0;
  }

  stanceSide(): Side | null {
    if (this.swingSide) return other(this.swingSide);
    if (this.skillSide) return other(this.skillSide);
    return null;
  }

  // ---------------------------------------------------------------- commands

  /** Put both feet in the air at their stance slots (on the gantry). */
  resetAir(frame: StanceFrame): void {
    for (const side of SIDES) {
      const f = this.feet[side];
      f.phase = 'air';
      f.place = this.slot(side, frame);
      f.target = { ...f.place };
    }
    this.phase = 'double';
    this.swingSide = null;
    this.skillSide = null;
    this.skillReady = false;
    this.anchored = false;
  }

  /** Plant both feet exactly where they are (after a get-up) and centre the COM between them. */
  plantBoth(s: Sense): void {
    for (const side of SIDES) this.plant(side, s);
    this.phase = 'double';
    this.swingSide = null;
    this.skillSide = null;
    this.skillReady = false;
    this.anchor(s);
    this.setGoal(this.doubleCenter([0, 0]), this.settleGain);
  }

  /** Start a step with `side` toward `target` (already constrained by the caller). */
  step(side: Side, target: FootPlace, timing: StepTiming): boolean {
    if (this.phase !== 'double' || !this.bothPlanted()) return false;
    const f = this.feet[side];
    f.target = target;
    f.lift = timing.lift;
    f.dur = timing.swing;
    this.beginShift(other(side), timing.shift, timing.shiftFraction);
    return true;
  }

  /** Ask for a leg (kick). Returns true once the weight is on the other foot and the leg is free. */
  requestSkillLeg(side: Side, maxShift: number): boolean {
    if (this.skillSide === side && this.skillReady) return true;
    if (this.skillSide === side) return false;
    if (this.phase !== 'double' || !this.bothPlanted()) return false;
    this.skillSide = side;
    this.skillReady = false;
    this.beginShift(other(side), maxShift, 1);
    return false;
  }

  skillLegActive(): Side | null {
    return this.skillSide && this.skillReady ? this.skillSide : null;
  }

  /**
   * The skill is done with the leg: swing it to `place` and plant. With `s`, the swing starts
   * from where the foot actually is (up in the air after a kick) rather than where it last stood.
   */
  returnSkillLeg(place: FootPlace, timing: StepTiming, s?: Sense): void {
    const side = this.skillSide;
    if (!side) return;
    const f = this.feet[side];
    this.skillSide = null;
    this.skillReady = false;
    if (f.phase !== 'skill') {
      // Still shifting: nothing lifted yet.
      this.phase = 'double';
      this.swingSide = null;
      this.setGoal(this.doubleCenter([0, 0]), this.settleGain);
      return;
    }
    if (s) {
      const fs = s.feet[side];
      f.place = { x: fs.sole[0], y: fs.sole[1], yaw: fs.yaw };
      f.startZ = Math.max(0, fs.height);
    }
    f.phase = 'swing';
    f.target = this.constrainTarget(side, place, MAX_FOOT_SEPARATION * this.geo.legLength);
    f.t = 0;
    f.dur = timing.swing;
    f.lift = timing.lift;
    f.lifted = true;
    this.phase = 'single';
    this.swingSide = side;
  }

  /**
   * The swing foot is needed to catch a fall: land it within `remaining` s. The swing keeps its
   * progress (no jump in the foot target), it just runs faster from here.
   */
  hurrySwing(remaining: number): void {
    const side = this.swingSide;
    if (!side) return;
    const f = this.feet[side];
    const u = f.t / f.dur;
    // A leg still coming down from a kick is heavy and high: rushing it only slides the stance foot.
    if (f.startZ > HURRY_MAX_START_Z || u >= HURRY_MAX_PROGRESS || f.dur - f.t <= remaining) return;
    const total = remaining / (1 - u);
    f.t = u * total;
    f.dur = total;
  }

  /** Withdraw a leg request: abandon the weight shift, or put a granted leg straight back down. */
  cancelSkillRequest(): void {
    const side = this.skillSide;
    if (!side) return;
    if (this.skillReady) {
      this.returnSkillLeg(this.feet[side].place, { shift: 0, shiftFraction: 1, swing: 0.3, lift: 0.03 });
      return;
    }
    this.skillSide = null;
    if (this.phase === 'shift') this.abortShift();
  }

  /**
   * Where `side` should land to stand square with the other (planted) foot, facing `heading`
   * (default: the way that foot itself points).
   */
  partnerSlot(side: Side, heading?: number): FootPlace {
    const o = other(side);
    const so = this.stance.slots[o];
    const p = this.feet[o].place;
    const h = heading ?? p.yaw - so.yaw;
    const [ox, oy] = rot2(so.x, so.y, h);
    return this.slot(side, { x: p.x - ox, y: p.y - oy, heading: h });
  }

  /** Where a skill left the free foot (sole centre, world), so the return swing starts there. */
  setSkillFootStart(place: FootPlace): void {
    if (this.skillSide) this.feet[this.skillSide].place = place;
  }

  // ---------------------------------------------------------------- update

  /**
   * Advances the gait, writes the leg commands for planted / swinging feet, and returns the
   * COM reference (position, velocity, acceleration) balance should track.
   */
  update(dt: number, s: Sense, legs: Record<Side, LegCommand>, shiftVec: P2): ComRef {
    this.landAirFeet(s);
    if (!this.anchored) return this.ref;
    this.trackSlip(s);
    if (this.phase === 'shift') this.advanceShift(dt, s);
    if (this.phase === 'single') this.advanceSwing(dt, s);
    if (this.phase === 'double') this.setGoal(this.doubleCenter(shiftVec), this.settleGain);
    this.reanchorIfLost(s);
    this.dcm.step(dt, s.omega0, this.ref);
    for (const side of SIDES) this.writeLeg(side, legs[side]);
    return this.ref;
  }

  private landAirFeet(s: Sense): void {
    for (const side of SIDES) {
      const f = this.feet[side];
      if (f.phase === 'air' && s.feet[side].height < TOUCHDOWN_HEIGHT) this.plant(side, s);
    }
    if (!this.anchored && this.bothPlanted()) {
      this.anchor(s);
      this.setGoal(this.doubleCenter([0, 0]), this.settleGain);
    }
  }

  /** Restart the plan from where the robot actually is. */
  anchor(s: Sense): void {
    this.dcm.reset([s.com[0], s.com[1]], [s.comVel[0], s.comVel[1]], s.omega0);
    this.anchored = true;
  }

  /** A shove can put the robot far off its plan; re-plan from reality instead of chasing it. */
  private reanchorIfLost(s: Sense): void {
    const e = Math.hypot(s.com[0] - this.dcm.c[0], s.com[1] - this.dcm.c[1]);
    if (e > REANCHOR_ERROR_M) this.dcm.reset([s.com[0], s.com[1]], [s.comVel[0], s.comVel[1]], s.omega0);
  }

  /** A planted sole that slid or spun (a whipping kick, a shove) is re-planted where it now is. */
  private trackSlip(s: Sense): void {
    for (const side of SIDES) {
      const f = this.feet[side];
      const fs = s.feet[side];
      if (f.phase !== 'planted' || fs.height > TOUCHDOWN_HEIGHT) continue;
      const moved = Math.hypot(fs.sole[0] - f.place.x, fs.sole[1] - f.place.y);
      if (moved > SLIP_M || Math.abs(wrapAngle(fs.yaw - f.place.yaw)) > SLIP_YAW_RAD) this.plant(side, s);
    }
  }

  private setGoal(goal: P2, gain: number): void {
    this.dcm.goal = [goal[0], goal[1]];
    this.dcm.k = gain;
  }

  private plant(side: Side, s: Sense): void {
    const f = this.feet[side];
    const fs = s.feet[side];
    f.phase = 'planted';
    f.place = { x: fs.sole[0], y: fs.sole[1], yaw: fs.yaw };
    f.target = { ...f.place };
    f.t = 0;
    f.startZ = 0;
    f.lifted = false;
  }

  private beginShift(stance: Side, maxShift: number, fraction: number): void {
    this.phase = 'shift';
    this.swingSide = other(stance);
    this.shiftT = 0;
    this.shiftMax = maxShift;
    if (maxShift > 0.01) this.setGoal(this.stanceTarget(stance, fraction), this.shiftGain);
  }

  private stanceTarget(stance: Side, fraction: number): P2 {
    const c = this.doubleCenter([0, 0]);
    const sp = this.feet[stance].place;
    return [c[0] + (sp.x - c[0]) * fraction, c[1] + (sp.y - c[1]) * fraction];
  }

  /**
   * Lift off only once the capture point sits over the stance sole: the COM is then heading
   * for that foot and single support is capturable. (A foot cannot leave the canvas while the
   * body is falling onto it, however good the planned landing.) A shift that times out is
   * abandoned rather than forced.
   */
  private advanceShift(dt: number, s: Sense): void {
    this.shiftT += dt;
    const side = this.swingSide!;
    const stance = other(side);
    const immediate = this.shiftMax <= 0.01;
    const settledCom = Math.hypot(s.comVel[0], s.comVel[1]) < LIFT_MAX_COM_SPEED;
    const overSole = this.shiftT >= MIN_SHIFT_S && settledCom && this.insideFoot(stance, [s.capture[0], s.capture[1]], LIFT_DEPTH * this.geo.legs[stance].footHalfWidth);
    if (!immediate && !overSole) {
      if (this.shiftT >= this.shiftMax) this.abortShift();
      return;
    }
    const f = this.feet[side];
    f.lifted = false;
    if (this.skillSide === side) {
      f.phase = 'skill';
      this.skillReady = true;
      this.phase = 'skill';
      return;
    }
    f.phase = 'swing';
    f.t = 0;
    this.phase = 'single';
  }

  /** Abandon a weight shift (the capture point ran away: a capture step is needed instead). */
  cancelShift(): void {
    if (this.phase === 'shift') this.abortShift();
  }

  /** How far the pelvis should dip for the step in progress (longer steps need more reach). */
  stepDip(): number {
    const side = this.swingSide;
    if (!side || (this.phase !== 'shift' && this.phase !== 'single')) return 0;
    const f = this.feet[side];
    const d = Math.hypot(f.target.x - f.place.x, f.target.y - f.place.y);
    return clamp(DIP_PER_METRE * d, 0, MAX_DIP_FRACTION * this.geo.legLength);
  }

  private abortShift(): void {
    this.phase = 'double';
    this.swingSide = null;
    this.skillSide = null;
    this.skillReady = false;
    this.abortedShifts++;
    this.setGoal(this.doubleCenter([0, 0]), this.settleGain);
  }

  private advanceSwing(dt: number, s: Sense): void {
    const side = this.swingSide!;
    const f = this.feet[side];
    f.t += dt;
    const u = f.t / f.dur;
    const h = s.feet[side].height;
    if (h > LIFTED_HEIGHT) f.lifted = true;
    const touching = h < TOUCHDOWN_HEIGHT;
    if ((u > 0.8 && touching && f.lifted) || (u >= 1 && touching) || u >= 1 + LATE_LAND_EXTRA_S / f.dur) {
      this.plant(side, s);
      this.phase = 'double';
      this.swingSide = null;
      this.stepsTaken++;
    }
  }

  private doubleCenter(shiftVec: P2): P2 {
    const l = this.feet.l.place, r = this.feet.r.place;
    return [(l.x + r.x) / 2 + shiftVec[0], (l.y + r.y) / 2 + shiftVec[1]];
  }

  private writeLeg(side: Side, leg: LegCommand): void {
    const f = this.feet[side];
    if (f.phase === 'skill') return; // the skill writes this leg
    let place = f.place;
    let z = 0;
    if (f.phase === 'swing') {
      const u = clamp(f.t / f.dur, 0, 1);
      // Lift first, travel, then set down: the sole clears the canvas before it moves.
      const k = minJerk((u - SWING_TRAVEL_START) / (SWING_TRAVEL_END - SWING_TRAVEL_START));
      place = {
        x: f.place.x + (f.target.x - f.place.x) * k,
        y: f.place.y + (f.target.y - f.place.y) * k,
        yaw: f.place.yaw + wrapAngle(f.target.yaw - f.place.yaw) * k,
      };
      const late = f.t > f.dur ? Math.min(1, (f.t - f.dur) / LATE_LAND_EXTRA_S) : 0;
      const descend = f.startZ * (1 - minJerk(u / SWING_TRAVEL_END));
      z = descend + f.lift * Math.sin(Math.PI * u) - 0.02 * late;
    }
    this.footCommand(side, place, z, leg);
    leg.measured = f.phase === 'swing';
    leg.ankleStiffness = f.phase === 'swing' ? 0 : this.plantedAnkleStiffness;
  }

  footCommand(side: Side, place: FootPlace, lift: number, leg: LegCommand): void {
    const g = this.geo.legs[side];
    leg.mode = 'foot';
    leg.measured = false;
    leg.ankleStiffness = 1;
    leg.ankle = [place.x - Math.cos(place.yaw) * g.footCenterX, place.y - Math.sin(place.yaw) * g.footCenterX, g.soleDepth + lift] as Vec3;
    leg.footRot = rotZ(place.yaw);
  }

  // ---------------------------------------------------------------- step geometry

  /** Keeps a swing target within `maxSep` of the stance sole and clear of it (feet never cross). */
  constrainTarget(side: Side, target: FootPlace, maxSep: number): FootPlace {
    const st = this.feet[other(side)].place;
    const L = this.geo.legLength;
    // Work in the stance foot's frame, with +y pointing toward the swing side.
    const sign = side === 'l' ? 1 : -1;
    let [rx, ry] = rot2(target.x - st.x, target.y - st.y, -st.yaw);
    ry *= sign;
    ry = Math.max(ry, MIN_LATERAL_GAP * L);
    const d = Math.hypot(rx, ry);
    const dMin = MIN_FOOT_SEPARATION * L, dMax = maxSep;
    if (d < dMin) {
      rx *= dMin / d;
      ry *= dMin / d;
    } else if (d > dMax) {
      rx *= dMax / d;
      ry *= dMax / d;
    }
    const [wx, wy] = rot2(rx, ry * sign, st.yaw);
    // Feet may not splay beyond what the hips can twist between them.
    const maxRel = 2 * (0.7 - HIP_YAW_MARGIN);
    const rel = clamp(wrapAngle(target.yaw - st.yaw), -maxRel, maxRel);
    return { x: st.x + wx, y: st.y + wy, yaw: st.yaw + rel };
  }
}

export const other = (s: Side): Side => (s === 'l' ? 'r' : 'l');
