// The balance engine (docs/design/balance-engine.md): one footstep plan, one DCM reference, the
// soles first and the gyro for emergencies. Runs every control tick (500 Hz) in place of the old
// gait COM plan, stance-step planner and posture gyro terms when CONTROL.balance is 'dcm'.
//
//   sense      ξ = c + ċ/ω₀ (sense.ts)
//   plan       footsteps (per event: lift-off, touchdown, a new goal) → CMP knots → ξ_ref(t), r_ref(t)
//   feedback   r_cmp = r_ref + (1 + k_p/ω)(ξ − ξ_ref)
//   allocate   COP = r_cmp clipped into the soles (shrunk 1.5 cm); the rest is the gyro's
//              emergency share; beyond that the step adjuster moves and hurries the landing,
//              and in double support a capture step goes out
//   posture    the pelvis follows the body (the joints do not fight the motion) at a constant
//              height; the ground force is fed forward through Jᵀ·F at the planned COP, so the
//              soles, not position errors, move the body; stance ankles soften to 0.3
//   feet       planted feet hold; the swing foot flies a quintic that re-plans from its commanded
//              state whenever the landing moves
// The engine writes the leg commands, the pelvis target, the COP for the feed-forward, the gyro
// command and the per-joint gain scales; the controller does the rest (arms, waist, yaw, IK).
import type { RobotRuntime } from '../../sim-context';
import { GAZE_STABILIZE_KEY } from '../../systems/gaze';
import { other, type Gait, type StanceFrame } from '../gait';
import { SIDES, type HumanoidGeometry, type Side } from '../geometry';
import { clamp } from '../math';
import type { JointMap, LegCommand } from '../posture';
import type { Sense } from '../sense';
import type { StanceParams } from '../stance';
import { skillCaptureStep } from '../stepping';
import { clampToPolygon, footCorners, polygonDistance, type FootPlace, type P2 } from '../support';
import { ComReference } from './com-ref';
import { DcmPlan, newDcmSample } from './dcm';
import { FOOTWORK_TUNING, FootstepPlanner, soleCmp, type GaitKind } from './footsteps';
import { gyroPolicy, newGyroCommand } from './gyro-policy';
import { adjustSwing, captureStep, followCapture } from './step-adjust';
import { Swing } from './swing';
import type { BalanceProbe, BalanceState } from './types';

export { CONTROL } from './config';
export type { BalanceProbe, BalanceState, Footstep } from './types';

/** Engine tuning (exported so tools can sweep it; the worker never changes it). */
export const BALANCE_TUNING = {
  kp: 1.5, // DCM error decay rate, × ω₀ (feedback gain 1 + k_p/ω = 2.5)
  ki: 0, // leaky integral gain, × ω₀ (double support only)
  integTauS: 10,
  copShrinkM: 0.015, // the COP stays this far inside the soles
  swingLeadS: 0.04, // the swing command runs ahead of the clock (a heavy leg lags its servo)
  blendS: 0.1, // a re-plan's DCM jump decays with this time constant
  replanGoalM: 0.05, // a goal that moved this far (or turned this much) re-plans the footsteps...
  replanGoalRad: 0.1,
  replanEveryS: 0.12, // ...at most this often
  replanMovingM: 0.15, // while footsteps are planned, the goal must move this far to re-plan them
  liftWaitS: 0.25, // a lift that is not ready waits this long, then the plan starts over
  liftMaxOutM: 0.05, // the DCM may sit this far outside the stance sole at lift-off
  earlyTouch: 0.75, // a swing touching down after this share of its time is planted
  earlyTouchWalk: 0.9,
  lateTouchS: 0.12,
  touchdownM: 0.006, // sole this close to the canvas: contact
  liftedM: 0.015,
  kickPreW: 1.0, // weight onto the stance foot over this × 1/ω₀ before a kick
  kickGrantDepth: 0.3, // DCM this deep inside the stance sole (× its half-width) frees the leg
  kickGrantSpeed: 0.35, // m/s COM speed
  stanceAnkleKp: 0.3, // stance ankle gain scale (kv scales with its square root)
  forceFF: 1, // share of the planned horizontal ground force fed forward through Jᵀ·F
  restShare: 0, // a planted foot carrying less of the weight than this rests where it is (0: never; resting the lightly loaded leg left the soles unable to shift the weight back, and a held stance drifted)
  captureErrM: 0.05, // moving: DCM error against the plan (plus half the gyro's reach) for a capture step
  trimTauS: 0.4, // holding still: the pelvis trim closes the body's DCM error to the plan at this rate...
  trimMaxM: 0.04, // ...by at most this much, and only below this error...
  trimSpeed: 0.1, // ...and this COM speed (m/s)
  stableSpeed: 0.3, // m/s and rad/s: stable (Euphoria's thresholds)
  stableErrM: 0.05, // DCM error under this counts as stable
  strikeReserve: 0.6, // gyro momentum free to start a strike...
  kickReserve: 0.6, // ...or a kick
};

export interface EngineInput {
  goal: StanceFrame | null;
  bearing: number;
  oppDist: number;
  aggression: number;
  speed: number | null;
  /** No new footsteps (a skill holds the feet, the get-up rise): the in-progress swing lands. */
  holdFeet: boolean;
  /** World COM offset a strike wants (weight transfer). */
  shift: P2;
  allowCapture: boolean;
  gyroHealth: number;
  gyroSaturation: number;
  gyroTorqueNm: number;
  gyroMomentumNms: number;
  legs: Record<Side, LegCommand>;
}

const ZERO: P2 = [0, 0];

export class BalanceEngine {
  readonly dcm = new DcmPlan();
  readonly planner: FootstepPlanner;
  readonly swing = new Swing();
  readonly ref = newDcmSample();
  readonly state: BalanceState = {
    xi: [0, 0], xiRef: [0, 0], margin: 1, gyroReserve: 1, mode: 'steady', clipRate: 1, clipSync: { hold: false },
    canStrike: false, canKick: false,
  };
  readonly gyro = newGyroCommand();
  /** The COM the posture tracks (an inverted pendulum under the CMP the soles can make). */
  readonly com = new ComReference();
  /** Horizontal pelvis target. */
  readonly pelvis: P2 = [0, 0];
  /** COP the soles are asked for (the controller adds the gyro's bleed). */
  readonly cop: P2 = [0, 0];
  /** Commanded CMP (plan + feedback), and the share the gyro was asked to deliver. */
  readonly cmp: P2 = [0, 0];
  readonly gyroShare: P2 = [0, 0];
  /** Horizontal ground force wanted from the soles, N (the COM's planned acceleration × m). */
  readonly force: P2 = [0, 0];
  /** A capture step started this tick (the controller abandons the skill). */
  captured = false;
  private swingSide: Side | null = null;
  private landNom: FootPlace = { x: 0, y: 0, yaw: 0 };
  private readonly blend: P2 = [0, 0];
  private blendT = 0;
  private readonly integ: P2 = [0, 0];
  private planned = false;
  private lastPlanT = -Infinity;
  private holdPlan = false;
  private waitSince = -1;
  private kickSince = -1;
  private doubleSince = 0;
  private wasHolding = true;
  private lastSaturation = 0;
  private driveSet = false;
  private lastLanded: Side | null = null;
  /** The swing in the air is a capture step (planned where the DCM will be, timed for the leg). */
  private capturing = false;
  private readonly xiM: P2 = [0, 0];
  /** Pelvis trim while holding still (the servos hold the body wherever it settled). */
  private readonly trim: P2 = [0, 0];
  /** COM velocity the controller works with: the rest of the body's while a leg swings. */
  private readonly vCtl: P2 = [0, 0];
  private readonly scratch = newDcmSample();
  private readonly tmpPlace: FootPlace = { x: 0, y: 0, yaw: 0 };

  constructor(
    readonly geo: HumanoidGeometry,
    readonly stance: StanceParams,
    readonly gait: Gait,
    readonly jm: JointMap,
    private readonly r: RobotRuntime,
    readonly probe: BalanceProbe,
  ) {
    this.planner = new FootstepPlanner(geo, stance, gait);
  }

  /** The swing leg's drive for the planner: hip pitch motor, leg mass from the compiled model. */
  private setDrive(s: Sense): void {
    const hip = this.r.joints[this.jm.leg.l.hipPitch];
    // One straight leg about its hip: its mass at ~45% of its length, plus its own rod inertia.
    const L = this.geo.legLength;
    this.planner.drive = {
      stallNm: hip.motor.stallTorqueNm, noLoadRadS: hip.motor.noLoadSpeedRadS,
      inertia: s.legs.l.mass * ((0.45 * L) ** 2 + (L * L) / 12),
    };
    this.driveSet = true;
  }

  get gaitName(): GaitKind {
    return this.planner.gait;
  }

  /** Walking (the hips square to the travel), not yet in the last two steps into the stance. */
  walking(): boolean {
    return this.planner.gait === 'walk' && !this.planner.arriving() && this.planner.count > this.planner.next;
  }

  /** Start over from the body as it is (after a get-up, on the gantry, after a fall). */
  reset(s: Sense | null): void {
    this.r.mem[GAZE_STABILIZE_KEY] = false;
    this.swing.stop();
    this.swingSide = null;
    this.planned = false;
    this.holdPlan = false;
    this.blend[0] = this.blend[1] = 0;
    this.integ[0] = this.integ[1] = 0;
    this.trim[0] = this.trim[1] = 0;
    this.waitSince = -1;
    this.kickSince = -1;
    this.wasHolding = true;
    this.lastLanded = null;
    this.capturing = false;
    this.planner.reset(s?.time ?? 0);
    this.com.primed = false;
    if (s) {
      this.com.reset(s);
      this.cmp[0] = this.cop[0] = s.capture[0];
      this.cmp[1] = this.cop[1] = s.capture[1];
      this.pelvis[0] = s.pelvisPos[0];
      this.pelvis[1] = s.pelvisPos[1];
    }
  }

  update(s: Sense, dt: number, inp: EngineInput): void {
    const g = this.gait;
    const t = s.time;
    const w = s.omega0;
    const T = BALANCE_TUNING;
    this.captured = false;
    if (!this.driveSet) this.setDrive(s);
    g.maintain(s);
    this.senseXi(s);
    if (g.phase === 'double' && !g.bothPlanted()) {
      // Feet in the air (dropped off the gantry, not landed yet): hold on, wait for the canvas.
      this.idle(s, inp);
      return;
    }
    let touched = false;
    // A swing the gait started (a kick handing its leg back): fly it from where the foot is.
    if (g.phase === 'single' && g.swingSide && (!this.swing.active || this.swingSide !== g.swingSide)) this.adoptSwing(s, g.swingSide);
    if (g.phase === 'single' && g.swingSide && this.swing.active) touched = this.touchdown(s, g.swingSide);
    else if (this.swing.active && g.phase !== 'single') {
      this.swing.stop();
      this.swingSide = null;
    }
    this.doubleSince = g.phase === 'double' ? this.doubleSince + dt : 0;
    // Plan: kicks and held feet stand on what they have; otherwise at every footstep event and
    // whenever the goal moves; a held stance refreshes its weight shift every tick.
    const kicking = g.phase === 'shift' || g.phase === 'skill';
    if (kicking) {
      this.kick(s);
      this.planHold(s, inp, true);
    } else if (inp.holdFeet) {
      if (g.phase === 'double') this.planHold(s, inp, false);
      else if (touched || !this.planned) this.replan(s, inp);
    } else if (touched || this.needsPlan(s, inp)) this.replan(s, inp);
    else if (this.holdPlan && g.phase === 'double') this.planHold(s, inp, false);
    // Lift-off when the plan says, if the body is ready.
    if (!kicking && !inp.holdFeet && g.phase === 'double' && g.bothPlanted()) this.maybeLift(s, inp);
    // The reference (its clock stops while a swing is late or a lift waits), feedback, allocation.
    this.dcm.sample(this.planClock(t), this.ref);
    const kb = Math.exp(-(t - this.blendT) / T.blendS);
    const xrx = this.ref.xi[0] + this.blend[0] * kb, xry = this.ref.xi[1] + this.blend[1] * kb;
    const ex = this.xiM[0] - xrx, ey = this.xiM[1] - xry;
    if (g.phase === 'double' && T.ki > 0) {
      const a = dt / T.integTauS;
      this.integ[0] += (ex - this.integ[0]) * a;
      this.integ[1] += (ey - this.integ[1]) * a;
    }
    this.state.xiRef[0] = xrx + T.ki * this.integ[0];
    this.state.xiRef[1] = xry + T.ki * this.integ[1];
    const support = g.supportPolygon();
    let shrunk = support.length >= 3 ? shrink(support, T.copShrinkM) : support;
    if (shrunk.length < 3) {
      const side = g.stanceSide();
      shrunk = side ? footCorners(this.geo, side, g.feet[side].place, T.copShrinkM) : shrunk;
    }
    // The COM reference runs the DCM feedback law on itself, under a CMP the soles (and, past
    // them, the gyro) can deliver; the posture tracks it.
    const hasGyro = inp.gyroHealth > 0;
    const reach = hasGyro ? gyroReach(s, inp) : 0;
    this.com.step(s, this.vCtl, dt, this.ref, this.state.xiRef, 1 + T.kp, shrunk, reach, this.cmp, this.cop, this.gyroShare);
    const cop = this.cop;
    // Gyro: damping, the emergency remainder; bleed only on two feet with margin.
    const inside = support.length >= 3 ? -polygonDistance(support, this.xiM).d : -1;
    gyroPolicy(s.mass, s.com[2], s.torsoOmega, hasGyro ? this.gyroShare : ZERO, inp.gyroSaturation, inside, g.phase === 'double' && g.bothPlanted(), this.gyro);
    // The step adjuster (in the air) and capture steps (on two feet).
    if (g.phase === 'single' && g.swingSide && this.swing.active) this.adjust(s, g.swingSide);
    else if (inp.allowCapture && g.phase === 'double' && g.bothPlanted()) this.capture(s, inp);
    if (g.phase === 'skill' && skillCaptureStep(g, this.geo, s, false)) {
      this.captured = true;
      g.captureSteps++;
    }
    // Posture: the pelvis moves the body onto the COM reference; the feed-forward carries the
    // reference's ground force (its acceleration without the gyro's share).
    this.com.pelvisTarget(s, this.vCtl, this.pelvis);
    this.updateTrim(s, dt, inp.holdFeet);
    this.force[0] = T.forceFF * s.mass * w * w * (this.com.c[0] - cop[0]);
    this.force[1] = T.forceFF * s.mass * w * w * (this.com.c[1] - cop[1]);
    this.writeLegs(s, inp.legs);
    this.writeImpedance();
    this.report(s, inp, inside, ex, ey);
    this.wasHolding = this.holdPlan && g.phase === 'double';
    // The head stays locked on its target in the world while the body turns under it (gaze.ts).
    this.r.mem[GAZE_STABILIZE_KEY] = true;
  }

  /**
   * Standing still on two feet, the servos hold the body wherever it settled and the COM reference
   * (leashed to the body) stops asking for the last centimetres: a slow integral trim on the
   * pelvis takes them out (as the legacy balance's trim does). Only at rest, near the plan and
   * with no skill running (a strike's weight transfer or a hit is not an offset to trim away); it
   * fades otherwise.
   */
  private updateTrim(s: Sense, dt: number, skill: boolean): void {
    const T = BALANCE_TUNING;
    const g = this.gait;
    const k = Math.min(1, dt / T.trimTauS);
    const err = Math.hypot(this.state.xiRef[0] - this.xiM[0], this.state.xiRef[1] - this.xiM[1]);
    const still = this.holdPlan && !skill && g.phase === 'double' && g.bothPlanted()
      && Math.hypot(s.comVel[0], s.comVel[1]) < T.trimSpeed && err < T.trimMaxM;
    for (let i = 0; i < 2; i++) {
      this.trim[i] = still
        ? clamp(this.trim[i] + (this.state.xiRef[i] - this.xiM[i]) * k, -T.trimMaxM, T.trimMaxM)
        : this.trim[i] * (1 - k);
      this.pelvis[i] += this.trim[i];
    }
  }

  /**
   * The DCM the controller works with: ξ = c + v/ω, where v is the rest of the body's velocity
   * while a leg swings (a heavy leg swinging forward carries a quarter of the mass at several m/s;
   * that momentum is internal and gone by touchdown, so it is not a fall to react to).
   */
  private senseXi(s: Sense): void {
    const g = this.gait;
    const side = g.phase === 'single' ? g.swingSide : null;
    let vx = s.comVel[0], vy = s.comVel[1];
    if (side) {
      const leg = s.legs[side];
      const rest = s.mass - leg.mass;
      if (rest > 1) {
        vx = (s.mass * s.comVel[0] - leg.mass * leg.vel[0]) / rest;
        vy = (s.mass * s.comVel[1] - leg.mass * leg.vel[1]) / rest;
      }
    }
    this.vCtl[0] = vx;
    this.vCtl[1] = vy;
    this.xiM[0] = s.com[0] + vx / s.omega0;
    this.xiM[1] = s.com[1] + vy / s.omega0;
  }

  // ---------------------------------------------------------------- planning

  /**
   * A new goal re-plans the footsteps only on two feet (the step in the air keeps its plan; the
   * step adjuster owns it), and only once it has moved enough: while walking, a goal set against a
   * moving opponent creeps every tick, and chasing it mid-swing only shakes the reference.
   */
  private needsPlan(s: Sense, inp: EngineInput): boolean {
    const g = this.gait;
    if (!this.planned) return true;
    if (g.phase !== 'double') return false;
    if (s.time - this.lastPlanT < BALANCE_TUNING.replanEveryS) return false;
    const p = this.planner.planned;
    const want = inp.goal;
    if (!want) {
      // Holding position: re-plan only to turn and face the opponent.
      return this.planner.gait !== 'hold' || Math.abs(angleDiff(p.heading, inp.bearing)) > BALANCE_TUNING.replanGoalRad;
    }
    const moving = this.planner.count > this.planner.next;
    const tol = moving ? BALANCE_TUNING.replanMovingM : BALANCE_TUNING.replanGoalM;
    return Math.hypot(want.x - p.x, want.y - p.y) > tol || Math.abs(angleDiff(want.heading, p.heading)) > BALANCE_TUNING.replanGoalRad;
  }

  /** The DCM reference right now, blend included. */
  private currentXiRef(t: number, out: P2): P2 {
    this.dcm.sample(this.planClock(t), this.scratch);
    const kb = Math.exp(-(t - this.blendT) / BALANCE_TUNING.blendS);
    out[0] = this.scratch.xi[0] + this.blend[0] * kb;
    out[1] = this.scratch.xi[1] + this.blend[1] * kb;
    return out;
  }

  /** Re-plan the footsteps; the new DCM reference blends in from the old one. */
  private replan(s: Sense, inp: EngineInput): void {
    const t = s.time;
    const g = this.gait;
    const oldXi: P2 = [this.xiM[0], this.xiM[1]];
    const cmpNow: P2 = [this.xiM[0], this.xiM[1]];
    if (this.planned) {
      this.currentXiRef(t, oldXi);
      this.dcm.cmpAt(this.planClock(t), cmpNow);
    }
    const sw = g.phase === 'single' && g.swingSide && this.swing.active
      ? { side: g.swingSide, target: this.swing.target, land: this.swing.t0 + this.swing.T }
      : null;
    // From rest (a held stance, or a lift that waited for a weight shift that never came): the
    // plan launches from the body's own DCM, with a full weight shift before the first lift.
    const fromRest = (this.wasHolding || this.waitSince >= 0) && !sw;
    this.planner.plan({
      time: t, omega: s.omega0, goal: inp.goal, bearing: inp.bearing, oppDist: inp.oppDist, aggression: inp.aggression,
      speed: inp.speed, cmpNow, shift: inp.shift, swing: sw, doubleS: this.doubleSince, fromRest, lastSide: this.lastLanded,
      opp: Number.isFinite(inp.oppDist) ? [s.com[0] + inp.oppDist * Math.cos(inp.bearing), s.com[1] + inp.oppDist * Math.sin(inp.bearing)] : null,
    }, this.dcm);
    this.planned = true;
    this.holdPlan = this.planner.count === 0 && !sw;
    this.lastPlanT = t;
    this.waitSince = -1;
    if (fromRest && this.planner.count > 0 && g.bothPlanted()) {
      // Starting from rest: the first CMP knot is chosen so the plan starts at the body's own DCM
      // (the launch pushes from behind it), inside the soles.
      const poly = shrink(g.supportPolygon(), BALANCE_TUNING.copShrinkM);
      this.dcm.connect(this.xiM, (p) => (poly.length >= 3 ? clampPoint(poly, p) : p));
      this.blend[0] = this.blend[1] = 0;
      this.blendT = t;
      this.com.reset(s, this.vCtl);
      return;
    }
    this.dcm.sample(t, this.scratch);
    this.blend[0] = oldXi[0] - this.scratch.xi[0];
    this.blend[1] = oldXi[1] - this.scratch.xi[1];
    this.blendT = t;
  }

  /**
   * Standing (or a kick's single support): the CMP slides onto the stance centroid plus the
   * strike's weight shift (or onto the kicking stance sole), re-planned every tick.
   */
  private planHold(s: Sense, inp: EngineInput, kicking: boolean): void {
    const g = this.gait;
    const t = s.time;
    const cmpNow: P2 = [this.xiM[0], this.xiM[1]];
    const oldXi: P2 = [this.xiM[0], this.xiM[1]];
    if (this.planned) {
      this.dcm.cmpAt(this.planClock(t), cmpNow);
      this.currentXiRef(t, oldXi);
    }
    let tx: number, ty: number;
    const stanceSide = g.stanceSide();
    if (kicking && stanceSide) {
      const p = g.feet[stanceSide].place;
      tx = p.x;
      ty = p.y;
    } else if (g.phase === 'single' && stanceSide) {
      [tx, ty] = soleCmp(this.geo, stanceSide, g.feet[stanceSide].place, 0.1);
    } else {
      const l = g.feet.l.place, r = g.feet.r.place;
      tx = (l.x + r.x) / 2 + inp.shift[0];
      ty = (l.y + r.y) / 2 + inp.shift[1];
    }
    const w = s.omega0;
    const tau = kicking ? BALANCE_TUNING.kickPreW / w : FOOTWORK_TUNING.finalDs / w;
    const fresh = !(this.holdPlan && this.planned);
    this.dcm.clear();
    this.dcm.add(t, cmpNow[0], cmpNow[1]);
    this.dcm.add(t + tau, tx, ty);
    this.dcm.solve(w);
    if (fresh) {
      // Coming out of a moving plan: blend its DCM in, and forget its footsteps.
      this.dcm.sample(t, this.scratch);
      this.blend[0] = oldXi[0] - this.scratch.xi[0];
      this.blend[1] = oldXi[1] - this.scratch.xi[1];
      this.blendT = t;
      this.planner.count = this.planner.next = 0;
      if (this.planner.gait !== 'hold') {
        this.planner.gait = 'hold';
        this.planner.gaitSince = t;
      }
      this.planner.planned.x = (g.feet.l.place.x + g.feet.r.place.x) / 2;
      this.planner.planned.y = (g.feet.l.place.y + g.feet.r.place.y) / 2;
      this.planner.planned.heading = inp.bearing;
      this.lastPlanT = t;
    }
    this.planned = true;
    this.holdPlan = true;
  }

  /** The plan's clock: it stops at a late swing's planned touchdown and at a waiting lift. */
  private planClock(t: number): number {
    const g = this.gait;
    if (g.phase === 'single' && this.swing.active) return Math.min(t, this.swing.t0 + this.swing.T);
    const up = this.planner.upcoming();
    if (up && g.phase === 'double' && !this.holdPlan) return Math.min(t, up.lift);
    return t;
  }

  // ---------------------------------------------------------------- stepping

  private maybeLift(s: Sense, inp: EngineInput): void {
    const step = this.planner.upcoming();
    if (!step || this.holdPlan || s.time < step.lift) return;
    const g = this.gait;
    if (this.ready(s, step.side, step.place, step.land - step.lift)) {
      g.engineStep(step.side, step.place, step.land - step.lift, step.clearance);
      const fs = s.feet[step.side];
      this.swing.start(s.time, g.feet[step.side].place, Math.max(0, fs.height), step.place, step.land - step.lift, step.clearance, BALANCE_TUNING.swingLeadS);
      this.swingSide = step.side;
      this.landNom = { ...step.place };
      this.planner.next++;
      this.probe.lifts++;
      this.waitSince = -1;
      // Re-time the plan from the real lift-off.
      this.replan(s, inp);
      return;
    }
    if (this.waitSince < 0) this.waitSince = s.time;
    else if (s.time - this.waitSince > BALANCE_TUNING.liftWaitS) this.replan(s, inp);
  }

  /** A foot may lift once the stance sole holds the DCM or the landing will catch it. */
  private ready(s: Sense, side: Side, place: FootPlace, swing: number): boolean {
    const g = this.gait;
    const stance = other(side);
    const sole = footCorners(this.geo, stance, g.feet[stance].place, 0);
    if (polygonDistance(sole, this.xiM).d <= BALANCE_TUNING.liftMaxOutM) return true;
    return g.captures(side, place, swing, s);
  }

  /** Take over a swing the gait started (a kick returning its leg). */
  private adoptSwing(s: Sense, side: Side): void {
    const f = this.gait.feet[side];
    const fs = s.feet[side];
    this.swing.start(s.time, { x: fs.sole[0], y: fs.sole[1], yaw: fs.yaw }, Math.max(0, fs.height), f.target, Math.max(0.15, f.dur), Math.max(0.02, f.lift), BALANCE_TUNING.swingLeadS * 0.5);
    this.swingSide = side;
    this.landNom = { ...f.target };
    this.planned = false;
    this.capturing = false;
  }

  private touchdown(s: Sense, side: Side): boolean {
    const g = this.gait;
    const f = g.feet[side];
    const sw = this.swing;
    const u = sw.progress(s.time);
    const h = s.feet[side].height;
    if (h > BALANCE_TUNING.liftedM) f.lifted = true;
    const touching = h < BALANCE_TUNING.touchdownM;
    const early = this.planner.gait === 'walk' ? BALANCE_TUNING.earlyTouchWalk : BALANCE_TUNING.earlyTouch;
    if ((u > early && touching && f.lifted) || (u >= 1 && touching) || s.time > sw.t0 + sw.T + BALANCE_TUNING.lateTouchS) {
      g.engineTouchdown(side, s);
      sw.stop();
      this.swingSide = null;
      this.lastLanded = side;
      this.capturing = false;
      this.probe.touchdowns++;
      this.probe.reserveAtTouchdown = 1 - this.lastSaturation;
      return true;
    }
    return false;
  }

  private adjust(s: Sense, side: Side): void {
    // A capture step already goes as fast as the leg can (hurrying it only lands it short): it
    // follows the DCM instead.
    if (this.capturing) {
      if (followCapture(this.geo, this.gait, this.swing, side, this.xiM, s.omega0, s.time)) this.gait.retargetSwing(this.swing.target);
      return;
    }
    this.dcm.sample(this.swing.t0 + this.swing.T, this.scratch);
    // The swing hip t from now: carried on by the body, which falls over the stance sole as an
    // inverted pendulum (c − p)(cosh ωt − 1) + (v/ω)·sinh ωt, not at its speed at lift-off (a
    // walk still gathering speed would otherwise see every planned landing out of reach).
    const hip = this.geo.legs[side].hip;
    const cy = Math.cos(s.heading), sy = Math.sin(s.heading);
    const hx = s.pelvisPos[0] + cy * hip[0] - sy * hip[1], hy = s.pelvisPos[1] + sy * hip[0] + cy * hip[1];
    const dx = s.com[0] - this.cop[0], dy = s.com[1] - this.cop[1];
    const vx = this.vCtl[0], vy = this.vCtl[1], w = s.omega0;
    const hipAt = (t: number): P2 => {
      const ch = Math.cosh(w * t) - 1, sh = Math.sinh(w * t) / w;
      return [hx + clamp(dx * ch + vx * sh, -0.6, 0.6), hy + clamp(dy * ch + vy * sh, -0.6, 0.6)];
    };
    const changed = adjustSwing(this.geo, this.gait, this.swing, side, {
      time: s.time, omega: w, decay: BALANCE_TUNING.kp * w, hipAt, hipReach: this.hipReach(side),
      xi: this.xiM, xiRef: this.state.xiRef, xiLand: this.scratch.xi, landNom: this.landNom,
      avail: [this.cop[0] - this.ref.r[0], this.cop[1] - this.ref.r[1]], short: [this.cmp[0] - this.cop[0], this.cmp[1] - this.cop[1]],
    });
    if (changed) this.gait.retargetSwing(this.swing.target);
  }

  /** Horizontal reach of a sole from its hip with the pelvis at stance height (sole centre). */
  private hipReach(side: Side): number {
    const leg = this.geo.legs[side];
    const vert = this.stance.pelvisHeight + leg.hip[2] - leg.soleDepth;
    const span = 0.97 * this.geo.legLength;
    return Math.sqrt(Math.max(0.01, span * span - vert * vert)) + leg.footCenterX;
  }

  private capture(s: Sense, inp: EngineInput): void {
    // Moving, the DCM runs ahead of the feet on purpose (the next step catches it): only an error
    // against the plan the soles and gyro cannot take back calls for a capture step.
    const reach = gyroReach(s, inp);
    if (!this.holdPlan && this.planner.upcoming()) {
      const e = Math.hypot(this.xiM[0] - this.state.xiRef[0], this.xiM[1] - this.state.xiRef[1]);
      if (e < BALANCE_TUNING.captureErrM + 0.5 * reach) return;
    }
    const plan = captureStep(this.geo, this.gait, s, reach, this.planner.drive);
    if (!plan) return;
    const g = this.gait;
    const lift = FOOTWORK_TUNING.walkLift * this.geo.legLength;
    g.engineStep(plan.side, plan.place, plan.swing, lift);
    this.swing.start(s.time, g.feet[plan.side].place, 0, plan.place, plan.swing, lift, BALANCE_TUNING.swingLeadS);
    this.swingSide = plan.side;
    this.landNom = { ...plan.place };
    g.captureSteps++;
    this.probe.lifts++;
    this.captured = true;
    this.capturing = true;
    // The plan: the stance sole holds the CMP where it is needed until the foot lands, then the
    // CMP slides onto the new support's centre.
    const cmpNow: P2 = [0, 0];
    this.dcm.cmpAt(this.planClock(s.time), cmpNow);
    const stance = g.feet[other(plan.side)].place;
    this.dcm.clear();
    this.dcm.add(s.time, cmpNow[0], cmpNow[1]);
    this.dcm.add(s.time + Math.min(0.05, plan.swing * 0.3), plan.cmp[0], plan.cmp[1]);
    this.dcm.add(s.time + plan.swing, plan.cmp[0], plan.cmp[1]);
    this.dcm.add(s.time + plan.swing + FOOTWORK_TUNING.finalDs / s.omega0, (stance.x + plan.place.x) / 2, (stance.y + plan.place.y) / 2);
    this.dcm.solve(s.omega0);
    this.planner.count = this.planner.next = 0;
    this.planner.gait = 'drag';
    this.planner.gaitSince = s.time;
    this.holdPlan = false;
    this.planned = true;
    this.blend[0] = this.blend[1] = 0;
    this.blendT = s.time;
    this.lastPlanT = s.time;
    this.probe.gait = 'capture';
  }

  /** Kicks: shift onto the stance foot, free the leg once the body sits over that sole. */
  private kick(s: Sense): void {
    const g = this.gait;
    if (g.phase !== 'shift') {
      this.kickSince = -1;
      return;
    }
    if (this.kickSince < 0) this.kickSince = s.time;
    const side = g.swingSide;
    if (!side) return;
    const stance = other(side);
    const since = s.time - this.kickSince;
    const T = BALANCE_TUNING.kickPreW / s.omega0;
    const depth = BALANCE_TUNING.kickGrantDepth * this.geo.legs[stance].footHalfWidth;
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    if (since >= 0.5 * T && speed < BALANCE_TUNING.kickGrantSpeed && g.insideFoot(stance, this.xiM, depth)) {
      g.grantSkillLeg();
      this.kickSince = -1;
      return;
    }
    if (since > g.shiftLimit()) {
      g.cancelShift();
      this.kickSince = -1;
    }
  }

  // ---------------------------------------------------------------- output

  private idle(s: Sense, inp: EngineInput): void {
    this.pelvis[0] = s.pelvisPos[0];
    this.pelvis[1] = s.pelvisPos[1];
    const l = this.gait.feet.l.place, r = this.gait.feet.r.place;
    this.cop[0] = this.cmp[0] = (l.x + r.x) / 2;
    this.cop[1] = this.cmp[1] = (l.y + r.y) / 2;
    this.gyroShare[0] = this.gyroShare[1] = 0;
    this.force[0] = this.force[1] = 0;
    gyroPolicy(s.mass, s.com[2], s.torsoOmega, ZERO, inp.gyroSaturation, -1, false, this.gyro);
    this.planned = false;
    this.com.reset(s);
    this.writeLegs(s, inp.legs);
    this.writeImpedance();
    this.report(s, inp, -1, 0, 0);
  }

  private writeLegs(s: Sense, legs: Record<Side, LegCommand>): void {
    const g = this.gait;
    for (const side of SIDES) {
      const f = g.feet[side];
      const leg = legs[side];
      if (f.phase === 'skill') continue; // the kick owns it
      if (f.phase === 'swing' && this.swing.active && this.swingSide === side) {
        this.swing.sample(s.time);
        const p = this.swing.pos;
        this.tmpPlace.x = p[0];
        this.tmpPlace.y = p[1];
        this.tmpPlace.yaw = p[2];
        g.footCommand(side, this.tmpPlace, this.swing.z, leg);
        leg.measured = true;
        leg.ankleStiffness = 0;
        continue;
      }
      g.footCommand(side, f.place, 0, leg);
      // A planted foot the plan barely loads rests where it is (solved from the measured pelvis):
      // solved from the commanded pelvis, which leads the body, it would be pushed along the canvas.
      leg.measured = f.phase === 'planted' && this.loadShare(side) < BALANCE_TUNING.restShare;
      leg.ankleStiffness = g.plantedAnkleStiffness;
    }
  }

  /** The share of the body's weight the planned COP puts on `side` (1 on one foot). */
  private loadShare(side: Side): number {
    const g = this.gait;
    if (!g.planted(side)) return 0;
    const o = other(side);
    if (!g.planted(o)) return 1;
    const a = g.feet[side].place, b = g.feet[o].place;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = ((this.cop[0] - a.x) * dx + (this.cop[1] - a.y) * dy) / Math.max(1e-6, dx * dx + dy * dy);
    return clamp(1 - t, 0, 1);
  }

  /** Stance ankles soft (the COP comes from the feed-forward, not from position error). */
  private writeImpedance(): void {
    const r = this.r;
    let kp = r.mem.gainScale as Float64Array | undefined;
    let kv = r.mem.dampScale as Float64Array | undefined;
    if (!kp || !kv) {
      kp = new Float64Array(r.joints.length).fill(1);
      kv = new Float64Array(r.joints.length).fill(1);
      r.mem.gainScale = kp;
      r.mem.dampScale = kv;
    }
    const soft = BALANCE_TUNING.stanceAnkleKp, softV = Math.sqrt(soft);
    for (const side of SIDES) {
      const m = this.jm.leg[side];
      const planted = this.gait.planted(side);
      kp[m.anklePitch] = kp[m.ankleRoll] = planted ? soft : 1;
      kv[m.anklePitch] = kv[m.ankleRoll] = planted ? softV : 1;
    }
  }

  /** Back to the servos as built (legacy path, a knockout, the get-up). */
  clearImpedance(): void {
    const kp = this.r.mem.gainScale as Float64Array | undefined;
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    kp?.fill(1);
    kv?.fill(1);
  }

  private report(s: Sense, inp: EngineInput, inside: number, ex: number, ey: number): void {
    const st = this.state;
    const g = this.gait;
    this.lastSaturation = inp.gyroSaturation;
    st.xi[0] = this.xiM[0];
    st.xi[1] = this.xiM[1];
    st.gyroReserve = inp.gyroHealth > 0 ? 1 - inp.gyroSaturation : 0;
    const cp = clamp(0.5 + inside / 0.2, 0, 1);
    st.margin = clamp(cp - 0.4 * inp.gyroSaturation, 0, 1);
    st.mode = this.probe.gait === 'capture' ? 'recover' : 'steady';
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    const rate = Math.hypot(s.torsoOmega[0], s.torsoOmega[1]);
    const stable = speed < BALANCE_TUNING.stableSpeed && rate < BALANCE_TUNING.stableSpeed && inside > 0 && Math.hypot(ex, ey) < BALANCE_TUNING.stableErrM;
    const planted = g.phase === 'double' && g.bothPlanted();
    st.canStrike = planted && stable && (inp.gyroHealth <= 0 || st.gyroReserve >= BALANCE_TUNING.strikeReserve);
    st.canKick = st.canStrike && (inp.gyroHealth <= 0 || st.gyroReserve >= BALANCE_TUNING.kickReserve) && s.feet.l.flat > 0.97 && s.feet.r.flat > 0.97;
    const p = this.probe;
    p.cop[0] = this.cop[0];
    p.cop[1] = this.cop[1];
    p.cmp[0] = this.cmp[0];
    p.cmp[1] = this.cmp[1];
    p.xi[0] = this.xiM[0];
    p.xi[1] = this.xiM[1];
    p.xiRef[0] = st.xiRef[0];
    p.xiRef[1] = st.xiRef[1];
    if (p.gait !== 'capture' || g.phase === 'double') p.gait = g.phase === 'shift' || g.phase === 'skill' ? 'skill' : this.planner.gait;
  }
}

/**
 * How far past the soles the gyro can carry the CMP for one event: its torque over m·g, cut by
 * the momentum it has left, (τ/mg)·(1 − e^{−ω·H_free/τ}) (§3.7).
 */
function gyroReach(s: Sense, inp: EngineInput): number {
  const tau = inp.gyroTorqueNm * inp.gyroHealth;
  if (tau <= 0) return 0;
  const free = inp.gyroMomentumNms * Math.max(0, 1 - inp.gyroSaturation);
  return (tau / (s.mass * 9.81)) * (1 - Math.exp(-(s.omega0 * free) / tau));
}

function clampPoint(poly: P2[], p: [number, number]): [number, number] {
  const c = clampToPolygon(poly, p);
  return [c[0], c[1]];
}

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Shrink a convex polygon toward its centroid by about `margin` metres. */
function shrink(poly: P2[], margin: number): P2[] {
  let cx = 0, cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, d - margin) / d;
    return [cx + dx * k, cy + dy * k] as P2;
  });
}
