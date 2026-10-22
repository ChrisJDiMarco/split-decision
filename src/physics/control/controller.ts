// Per-robot humanoid controller, every control tick:
//   sense → skill (arms, torso, borrowed leg) → steps → gait (legs, COM plan) → balance
//   (pelvis target, gyro) → IK → velocity + gravity feed-forward → servo targets
import type { FeintRead, TargetZone } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import { latestRead } from '../openings';
import type { RobotRuntime, SimContext } from '../sim-context';
import { Balance } from './balance';
import { Behaviours } from './balance/behaviours';
import { BalanceEngine, CONTROL } from './balance/index';
import { REACTIONS } from './balance/reactions';
import { Inertializer } from './balance/inertialize';
import { MOCAP_STYLE, MocapStyle } from './balance/mocap-style';
import { TrunkLimiter, trunkLimiterFor, type TrunkStyle } from './balance/trunk-limit';
import { newProbe, type BalanceProbe } from './balance/types';
import { applyGravityFeedforward, INVERSE_DYNAMICS, InverseDynamics, jointInfo, VelocityFeedforward, type InverseDynamicsInput, type JointInfo } from './feedforward';
import { Gait, type StanceFrame, type StepTiming } from './gait';
import { humanoidGeometry, SIDES, type HumanoidGeometry, type Side } from './geometry';
import { GetUp, getUpTuning } from './getup';
import { getupSpeed, type GetupSpeed } from './getup-speed';
import { GyroCore } from './gyro';
import { footLoads, reachablePelvisYaw, soleRoll } from './loads';
import { clamp, mulMM, mulMtV, readVec, rot2, rotationError, rotY, rotZ, sub, wrapAngle, yawPitchRoll, type Mat3 } from './math';
import { ClipFootwork } from './mocap/footwork';
import { Victory } from './mocap/victory';
import { ClipGetUp } from './mocap/getup';
import { mocapSet, type MocapSet } from './mocap/library';
import { MotionPlayer } from './mocap/player';
import { mocapSkill, registerMocapRanges } from './mocap/skills';
import { STRIKE_P3 } from './mocap/strikes';
import { jointMap, newBodyCommand, solveBody, type BodyCommand, type JointMap } from './posture';
import { bodyIds, GRAVITY, robotMass, sense, views, type BodyIds, type Sense } from './sense';
import { isStrikeSkill, SKILLS, type SkillId } from './skills';
import { SkillRunner } from './skills/runner';
import { opponentView, type OpponentView } from './skills/targets';
import { neutralPose, type SkillDef, type SkillEnv, type SkillPose } from './skills/types';
import { stanceFor, type StanceParams } from './stance';
import { adjustSwing, captureStep, HOLD_TOL, MOVE_TOL, planStep, skillCaptureStep } from './stepping';
import { anyContact } from './contacts';
import { clampToPolygon, convexHull, footCorners, type P2 } from './support';
import { Rise } from './rise';
import { rollKeysFor } from './roll-keys';
import { UpperBodyStrategy } from './strategies';
import { StrikeDrive } from './strike-drive';
import { TacticRunner } from './tactics';
import { Walker } from './walk';

export const DEFAULT_TIMING: StepTiming = { shift: 1.2, shiftFraction: 1, swing: 0.3, lift: 0.05 };
const MASS_REFRESH_S = 0.25;
const DIP_TAU_S = 0.12;
/** Yaw handling (exported so tools can sweep it; the worker never changes it). */
export const YAW_TUNING = {
  // How far the pelvis yaw target may lead the measured yaw. The stance hip yaw servo reaches full
  // torque within a few degrees, and a single sole's friction cannot resist that: a larger error
  // spins the stance foot instead of the body. Two spread feet hold much more.
  leadSingle: 0.06, // rad, on one foot...
  leadDouble: 0.25, // ...and on two
  stumbleM: 0.35, // capture point this far outside the feet in double support: clip footwork gives way to capture steps
  // The balance engine's leads. A lead is a hip yaw torque on the planted sole, whose torsional grip
  // is a fraction of the servo's: measured, a 0.06 rad lead at full stiffness spun the stance sole
  // 10-27° a step and the heading drifted 30-60° over a walk. The engine softens the stance hip yaw
  // (BALANCE_TUNING.stanceHipYawKp) and keeps the leads moderate.
  dcmLeadSingle: 0.05,
  dcmLeadDouble: 0.15,
};
const NO_TORQUE: Vec3 = [0, 0, 0];
const DOWN_BLEED_S = 0.3; // going down, the gyro desaturates this fast (within its torque cap)...
const CANVAS_BLEED_S = 0.05; // ...and with the pelvis down on the canvas, at its full torque (bleedGyro)
const CANVAS_PELVIS = 0.35; // × stance pelvis height: below it the body is down on the canvas
const RISE_OFFSET_TAU_S = 0.04; // unfolding out of the crouch, the pelvis chases the moving COM this fast
const RISE_SLOW_INSIDE_M = 0.02; // the rise slows once the capture point is this close to the soles' edge...
const RISE_PAUSE_OUTSIDE_M = 0.03; // ...and all but stops this far outside them
const RISE_MIN_RATE = 0.1;
const WALK_SPEED = 0.55; // m/s closing the distance, at aggression 0.5
const WALK_ASSIST_SHARE = 0.6; // share of the gyro's torque a walk may use to steer the COM
/**
 * The fast walker (walk.ts) is unfinished: it drops the lighter robots within ~2-3 s. Until the
 * mocap footwork replaces it, fighters cover ground with the slower, stable stepping planner.
 */
const FAST_WALK_ENABLED = false;
const WALK_ASSIST_SAT = 0.6; // ...tapering to none as its rotor fills to this
const SPRINT_FACTOR = 1.15;
const MOCAP_POLL_S = 0.25; // how often to look for a motion library that is still loading
const STRIKE_UPRIGHT = 0.93; // torso up-axis z below which a strike waits
const STRIKE_MARGIN = 0.45; // balanceMargin() below which a strike waits
const STRIKE_MAX_SAT = 0.6; // gyro saturation above which a strike waits
// Hip assist: a waist motor too weak for the torso's weight (damaged, or lifting a heavy torso out
// of the get-up crouch) lets it sag forward past its target. The hips then tilt the pelvis back by
// that sag, so the torso stays upright on the strong hip motors and the waist's load drops.
const HIP_ASSIST_DEADBAND = 0.15; // rad of waist sag ignored
const HIP_ASSIST_MAX = 0.9; // rad
const HIP_ASSIST_TAU_S = 0.05;
/**
 * Waist counter-rotation on the balance engine (docs/design/balance-engine.md §4.3). Walking, the
 * ground's force swings the body's yaw momentum every step, and a sole's torsional friction is
 * small: the stance foot spun with the pelvis. With the guard up the arms cannot swing, so the
 * waist takes it: whenever the pelvis yaws, the waist turns the torso further the same way (its
 * servo's reaction brakes the pelvis), and the upper body carries the momentum instead of the feet.
 * The head stays on the opponent (gaze). Off during skills; eases back to the pose's own waist.
 */
export const COUNTER_YAW = {
  gain: 1.0, // waist yaw rate commanded per rad/s of pelvis yaw rate
  maxRad: 0.35,
  leakS: 0.5,
};

/** The balance engine's stance: 1.02 × the hip offset wide (docs/design/balance-engine.md §4.3). */
const DCM_STANCE = { widthFraction: 1.02 };
const GUARD_COM_LEAD_M = 0.07; // the COM sits about this far ahead of the torso origin in the stance
const GUARD_MEASURE_TAU_S = 1;

export class HumanoidController {
  readonly geo: HumanoidGeometry;
  readonly ids: BodyIds;
  readonly jm: JointMap;
  readonly joints: JointInfo[];
  readonly stance: StanceParams;
  readonly gait: Gait;
  readonly balance = new Balance();
  readonly gyro: GyroCore | null;
  readonly cmd: BodyCommand = newBodyCommand();
  readonly q: Float64Array;
  readonly velFF: VelocityFeedforward;
  readonly skills: SkillRunner;
  readonly tactics: TacticRunner;
  readonly getUp: GetUp;
  readonly walker: Walker;
  /** false: the robot just holds its design stance (a training dummy on a gantry). */
  enabled = true;
  mass = 0;
  heading = 0; // stance heading (toward the opponent)
  /** Desired stance frame for footwork; null holds position while facing the opponent. */
  goal: StanceFrame | null = null;
  timing: StepTiming = { ...DEFAULT_TIMING };
  lastSense: Sense | null = null;
  opp: OpponentView | null = null;
  pose: SkillPose;
  comRef: P2 = [0, 0];
  plannedCop: P2 = [0, 0];
  /** What the tools read every control tick (balance-drills, fight-metrics). */
  readonly probe: BalanceProbe = newProbe();
  /** The balance engine (CONTROL.balance = 'dcm'); null on the legacy path. */
  readonly engine: BalanceEngine | null;
  /** Servo-target switches decay instead of jumping (balance/inertialize.ts). */
  readonly inertia: Inertializer;
  /** The striking chain's burst damping and inertial feed-forward (strike-drive.ts; balance engine only). */
  readonly drive: StrikeDrive | null;
  /** Inverse-dynamics feed-forward (feedforward.ts; balance engine only). */
  readonly idyn: InverseDynamics | null;
  /** Phase 4: arms, waist, posture and stiffness for the reactions (balance/behaviours.ts; balance engine only). */
  readonly behaviours: Behaviours | null;
  /** The trunk style (dip, pelvis tilt, waist bend) made feasible for the feet (balance/trunk-limit.ts; balance engine only). */
  readonly trunkLimit: TrunkLimiter | null;
  private readonly trunkStyle: TrunkStyle = { pelvisDrop: 0, pelvisPitch: 0, pelvisRoll: 0, waistBend: 0 };
  /** This robot's geoms by part, and the other robot's geoms (the skin a hit is felt through). */
  private readonly skin: { mine: Map<number, string>; theirs: Set<number> };
  /** The design's get-up speeds (getup-speed.ts). */
  private readonly getupSpeed: GetupSpeed;
  /** The torso's up axis as commanded last tick (world). */
  private readonly torsoUpCmd: number[] = [0, 0, 1];
  private readonly idInput: InverseDynamicsInput;
  /** The Phase 1 feed-forward's torque per joint this tick (the reaction feed-forward adds to it). */
  private readonly tauFF: Float64Array;
  /** Requested ground speed from Intent.move (m/s), or null (the gait's own pace). */
  moveSpeed: number | null = null;
  /** Ring IQ: a walk toward the opponent ends this far from him (COM to COM, m; 0: at the goal). */
  walkEnd = 0;
  /**
   * A strike is due but the body is not ready for it yet (mid-step, still settling): no new step
   * lifts while this is set, so the step in the air is the last one before the blow (tactics.ts).
   */
  strikePending = false;
  private lastRun: unknown = null;
  private lastRising = false;
  private lastCelebrating = false;
  private dip = 0;
  private hipAssist = 0;
  private counterYaw = 0;
  /** The balance engine drove this tick (it does not during the get-up's rise: see stand()). */
  private engineDrove = false;
  /** How far the guard's front (the furthest fist face) sits ahead of the COM in the stance, m. */
  private guardFwd: number;
  /** How far the COM sits ahead of the stance frame's centre toward the opponent, standing, m. */
  private comFwd = 0.05;
  private massAge = 0;
  /** The design's motion library for playback (null until it has loaded, or none built). */
  mocap: MocapSet | null = null;
  /** Plays the mocap strikes (one skill runs at a time). */
  strikePlayer: MotionPlayer | null = null;
  /** Mocap footwork: covers ground with the library's shuffles and walks. */
  footwork: ClipFootwork | null = null;
  /** The winner's celebration once the opponent is knocked out. */
  victory: Victory | null = null;
  private celebrating = false;
  private readonly rng: () => number;
  private mocapAge = MOCAP_POLL_S;
  private lastStepSide: Side | null = null;
  private readonly qNow: Float64Array;
  private readonly rise: Rise;
  private readonly upperBody = new UpperBodyStrategy();
  /** Upper-body share of the mass × its height above the pelvis: how far a bend moves the COM. */
  private readonly upperLever: number;
  /** Arms and waist (the joints a skill or the mocap style layer owns). */
  private readonly upperJoints: number[];
  /** Arm segment masses (upper arm; forearm with the fist and hand) and the whole robot's, kg. */
  private readonly armMass: Record<Side, { upper: number; lower: number }>;
  private readonly fullMass: number;
  /** Mocap footwork's style layer (on the dcm path, once the motion library has loaded). */
  private mocapStyle: MocapStyle | null = null;
  /** Is a foot planted (for the strike drive's stance hips; one closure, not one per tick). */
  private readonly plantedFn = (side: Side): boolean => this.gait.planted(side);

  constructor(ctx: SimContext, readonly r: RobotRuntime) {
    this.geo = humanoidGeometry(r.design);
    this.ids = bodyIds(r);
    this.jm = jointMap(r);
    this.joints = jointInfo(r, ctx.model.dof_jntid);
    const dcm = CONTROL.balance === 'dcm';
    this.stance = stanceFor(this.geo, dcm ? DCM_STANCE : undefined);
    this.gait = new Gait(this.geo, this.stance);
    const subtreeMass = ctx.model.body_subtreemass;
    this.walker = new Walker(this.gait, this.geo, subtreeMass[this.ids.thigh.l] / subtreeMass[r.rootBody]);
    this.gyro = r.design.gyro ? new GyroCore(r.design.gyro) : null;
    this.q = new Float64Array(r.joints.length);
    this.velFF = new VelocityFeedforward(r.joints.length);
    this.skills = new SkillRunner(r, ctx.robots[r.corner === 0 ? 1 : 0]);
    this.tactics = new TacticRunner(this);
    this.qNow = new Float64Array(r.joints.length);
    const tuning = getUpTuning(r.design.id);
    const brace = Float64Array.from(r.joints, (j) => r.design.stance[j.name] ?? 0);
    this.getUp = new GetUp(this.geo, this.jm, this.stance, brace, tuning, rollKeysFor(r.design.id));
    this.getupSpeed = getupSpeed(r.design.id);
    this.getUp.speed = this.getupSpeed;
    this.rise = new Rise(tuning.riseS);
    this.pose = neutralPose(this.stance);
    const subtree = ctx.model.body_subtreemass;
    this.upperLever = (subtree[this.ids.torso] / subtree[r.rootBody]) * (this.geo.pelvisToTorso[2] + this.geo.torsoCenter[2]);
    const bm = ctx.model.body_mass;
    const part = (id: string) => r.parts.get(id)?.body ?? -1;
    const armOf = (side: Side) => ({ upper: part(`upperarm_${side}`) >= 0 ? bm[part(`upperarm_${side}`)] : 0, lower: subtree[this.ids.forearm[side]] });
    this.armMass = { l: armOf('l'), r: armOf('r') };
    this.fullMass = subtree[r.rootBody];
    this.mass = robotMass(views(ctx), this.ids);
    this.rng = ctx.rng;
    this.engine = dcm ? new BalanceEngine(this.geo, this.stance, this.gait, this.jm, r, this.probe) : null;
    const upper = r.joints.flatMap((j, i) => (/^(waist_|shoulder_|elbow_)/.test(j.name) ? [i] : []));
    this.upperJoints = upper;
    this.inertia = new Inertializer(r.joints.length, r.joints.map((j) => j.motor.noLoadSpeedRadS), [this.jm.neckYaw], upper);
    this.inertia.enabled = CONTROL.inertialize;
    this.drive = dcm ? new StrikeDrive(ctx, r, upper) : null;
    this.idyn = dcm ? new InverseDynamics(ctx.mj, ctx.model.nv, r) : null;
    this.behaviours = dcm ? new Behaviours(this.geo, this.jm, r) : null;
    this.trunkLimit = dcm ? trunkLimiterFor(ctx, r, this.fullMass) : null;
    const mine = new Map<number, string>();
    for (const [id, p] of r.parts) for (const g of p.geoms) mine.set(g, id);
    const theirs = new Set<number>();
    for (const p of ctx.robots[r.corner === 0 ? 1 : 0].parts.values()) for (const g of p.geoms) theirs.add(g);
    this.skin = { mine, theirs };
    if (this.engine) this.engine.reactions.touching = () => this.touchingOpponent(ctx);
    this.tauFF = new Float64Array(r.joints.length);
    this.idInput = {
      baseAcc: [0, 0], planted: { l: false, r: false }, support: [], plannedCop: [0, 0], gyro: null, gyroPlanned: [0, 0, 0], burst: null, capturing: false, recovering: false, kicking: false, striking: false,
      rates: this.velFF.rates, loads: (cop: P2) => footLoads(this.geo, this.gait, this.lastSense!, cop),
    };
    // The guard's reach from the stance geometry (the torso turned by the blade and the waist), less
    // the COM's usual lead over the torso origin; refined from the body once it stands (guardReach).
    const blade = this.stance.pelvisYaw + this.stance.waistYaw;
    const fwd = (side: Side) => this.stance.guard[side].fist[0] * Math.cos(blade) - this.stance.guard[side].fist[1] * Math.sin(blade);
    this.guardFwd = Math.max(fwd('l'), fwd('r')) - GUARD_COM_LEAD_M + this.geo.arms.l.fistHalf;
  }

  /**
   * How far the guard reaches ahead of the COM toward the opponent (the furthest fist face), m.
   * Two guards closer than the sum of their reaches touch (docs/design/ring-iq.md: no walking into
   * guard contact). Follows the body while it stands in its guard, so loadouts and damage count.
   */
  guardReach(): number {
    return this.guardFwd;
  }

  /** How far the COM stands ahead of the stance frame's centre toward the opponent (the stance
   *  goal is a frame: a COM-to-COM range needs it). */
  comLead(): number {
    return this.comFwd;
  }

  /** Tracks the guard's real reach while standing in it (no skill, both feet down). */
  private measureGuard(s: Sense, dt: number): void {
    if (this.skills.active() || this.pose.holdFeet || !this.gait.bothPlanted()) return;
    const ux = Math.cos(this.heading), uy = Math.sin(this.heading);
    let best = -Infinity;
    for (const side of SIDES) best = Math.max(best, (s.fists[side][0] - s.com[0]) * ux + (s.fists[side][1] - s.com[1]) * uy);
    const k = Math.min(1, dt / GUARD_MEASURE_TAU_S);
    this.guardFwd += (best + this.geo.arms.l.fistHalf - this.guardFwd) * k;
    const f = this.gait.currentFrame();
    this.comFwd += ((s.com[0] - f.x) * ux + (s.com[1] - f.y) * uy - this.comFwd) * k;
  }

  /** The skill this robot throws for `id`: the mocap version once its library is loaded. */
  skillFor(id: SkillId): SkillDef | undefined {
    return mocapSkill(this.mocap, id, !!this.engine) ?? SKILLS[id];
  }

  /** The newest read of this fighter's feints (the openings system's): a combination's payoff answers it. */
  feintRead(ctx: SimContext): FeintRead | null {
    return latestRead(ctx, this.r.corner);
  }

  /** Start a skill now (returns false if another is running or it cannot be used). */
  startSkill(def: SkillDef, zone: TargetZone = def.defaultZone, aggression = 0.6): boolean {
    return this.skills.start(def, zone, aggression);
  }

  update(ctx: SimContext, dt: number): void {
    if (!this.enabled) return this.passive(ctx);
    this.refreshMass(ctx, dt);
    this.attachMocap(dt);
    const s = sense(ctx, this.r, this.geo, this.ids, this.mass);
    this.lastSense = s;
    this.drive?.bind(ctx);
    this.opp = opponentView(ctx, ctx.robots[this.r.corner === 0 ? 1 : 0]);
    if (ctx.released && (this.getUp.active || this.r.koReason || this.checkFall(ctx, s, dt))) return this.down(ctx, s, dt);
    const bearing = Math.atan2(this.opp.com[1] - s.com[1], this.opp.com[0] - s.com[0]);
    if (!ctx.released) this.hang(s, bearing);
    else this.stand(ctx, s, dt, bearing);
    solveBody(this.cmd, this.geo, this.jm, this.q, { pos: s.pelvisPos, rot: s.pelvisRot, shin: { l: s.feet.l.shinRot, r: s.feet.r.shinRot } });
    if (this.engine && this.engineDrove) this.behaviours!.joints(this.engine.reactions, this.q);
    this.markSwitches();
    this.inertia.apply(this.q, dt);
    const e = this.engine;
    // On the balance engine a swinging leg is solved from the measured pelvis too, so its hip yaw
    // target carries the pelvis's own spin as well: no shift on either hip yaw.
    const engineLegs = !!e && this.engineDrove;
    for (const side of SIDES) this.velFF.hold[this.jm.leg[side].hipYaw] = engineLegs || this.gait.planted(side) ? 1 : 0;
    this.velFF.apply(this.r, this.q, dt);
    if (this.drive && this.engineDrove) this.drive.inertia(ctx, this.q, this.velFF, dt);
    const kickLeg = this.gait.phase === 'shift' || this.gait.phase === 'skill';
    const engineFF = !!e && !!this.idyn && ctx.released && this.engineDrove && INVERSE_DYNAMICS.enabled > 0;
    if (engineFF && INVERSE_DYNAMICS.full && (INVERSE_DYNAMICS.kicks || !kickLeg)) this.inverseDynamics(ctx, s, e!, dt);
    else {
      const ground = e && ctx.released && this.engineDrove ? { force: e.force, headroom: true } : undefined;
      applyGravityFeedforward(views(ctx), this.r, this.joints, footLoads(this.geo, this.gait, s, this.plannedCop), this.mass, this.q, 1, ground, engineFF ? this.tauFF : undefined);
      // The air leg's own inertia and its reaction on the stance leg, on top (INVERSE_DYNAMICS.full = 0).
      if (engineFF) this.inverseDynamics(ctx, s, e!, dt, this.tauFF);
    }
    this.r.targets.set(this.q);
    this.report();
  }

  /**
   * The balance engine's feed-forward: whole-body inverse dynamics with the planned COM acceleration and
   * the limbs' target accelerations, the ground wrench it needs at the soles (feedforward.ts).
   */
  private inverseDynamics(ctx: SimContext, s: Sense, e: BalanceEngine, dt: number, tauOld?: Float64Array): void {
    const inp = this.idInput;
    const w2 = s.omega0 * s.omega0;
    if (INVERSE_DYNAMICS.baseFromBody) {
      // The pelvis accelerates as the soles' planned COP (and the gyro's planned share) push the body's COM.
      inp.baseAcc[0] = w2 * (s.com[0] - e.cmpSoles[0] - e.gyroShare[0]);
      inp.baseAcc[1] = w2 * (s.com[1] - e.cmpSoles[1] - e.gyroShare[1]);
    } else {
      inp.baseAcc[0] = e.com.a[0];
      inp.baseAcc[1] = e.com.a[1];
    }
    inp.planted.l = this.gait.planted('l');
    inp.planted.r = this.gait.planted('r');
    inp.support = INVERSE_DYNAMICS.planSupport && e.copSupport.length >= 3 ? e.copSupport : this.gait.supportPolygon(INVERSE_DYNAMICS.copShrinkM);
    inp.plannedCop = this.plannedCop;
    inp.gyro = this.gyro ? this.gyro.applied : null;
    if (this.gyro && inp.gyroPlanned) {
      // The emergency share the plan asked for (CMP shift Δ ⇒ couple m·g·(Δy, −Δx)), as far as the core
      // delivered it (never more than it applied along that direction).
      const mg = s.mass * GRAVITY;
      const wx = mg * e.gyroShare[1], wy = -mg * e.gyroShare[0];
      const n2 = wx * wx + wy * wy;
      const k = n2 > 1e-9 ? Math.max(0, Math.min(1, (this.gyro.applied[0] * wx + this.gyro.applied[1] * wy) / n2)) : 0;
      inp.gyroPlanned[0] = wx * k;
      inp.gyroPlanned[1] = wy * k;
      inp.gyroPlanned[2] = 0;
    }
    inp.burst = this.drive?.burstChain ?? null;
    inp.capturing = e.catching;
    inp.recovering = e.recovering;
    inp.kicking = this.gait.phase === 'skill';
    inp.striking = this.skills.active();
    if (tauOld) this.idyn!.applyReaction(ctx, views(ctx), this.joints, inp, this.q, dt, tauOld);
    else this.idyn!.apply(ctx, views(ctx), this.joints, inp, this.q, dt);
    e.state.torqueReserve = Math.max(0, 1 - this.idyn!.probe.legLoad);
  }

  /**
   * Servo-target switches the inertializer should decay: a skill starting, ending or cancelled,
   * the rise out of a get-up starting or ending, the victory starting or stopping.
   */
  private markSwitches(): void {
    const run = this.skills.run;
    // (A brace's hands go out as fast as the arms can take them: a blow it cancels is not decayed into it.)
    const bracing = this.engine?.reactions.mode === 'brace';
    if (!bracing && (run !== this.lastRun || this.rise.active !== this.lastRising || this.celebrating !== this.lastCelebrating)) this.inertia.mark();
    // The mocap style layer changed clip (or jumped its clock to a real contact): its arms and waist decay over.
    const m = this.engine?.mocap;
    if (m?.switched) {
      this.inertia.mark(this.upperJoints);
      m.switched = false;
    }
    this.lastRun = run;
    this.lastRising = this.rise.active;
    this.lastCelebrating = this.celebrating;
  }

  /** Still standing up out of the get-up crouch (balance owns the body, the feet stay put). */
  get rising(): boolean {
    return this.rise.active;
  }

  /** Standing: has the robot just gone down? Abandons whatever it was doing if so. */
  private checkFall(ctx: SimContext, s: Sense, dt: number): boolean {
    if (!this.getUp.detect(s, dt, this.rise.active)) return false;
    // A braced fall keeps its catch through the landing (the arms stiff, the legs soft) instead of
    // snapping back to the stance shape.
    const caught = !!this.behaviours && this.behaviours.holdsCatch && this.behaviours.braceW > 0.5 && this.engineDrove;
    this.getUp.catchPose = caught ? Float64Array.from(this.r.targets) : null;
    this.behaviours?.reset();
    this.trunkLimit?.reset();
    this.rise.active = false;
    this.upperBody.reset();
    this.skills.cancel(this.skillEnv(s), true);
    this.tactics.onFall();
    this.walker.cancel();
    this.footwork?.cancel(this.gait, 'fell');
    this.victory?.reset();
    this.gait.resetAir(this.gait.currentFrame());
    this.goal = null;
    this.gyro?.release(views(ctx).xfrc, this.ids.torso);
    this.engine?.reset(null);
    this.engine?.reactions.setMode('down', s.time);
    if (this.engine) this.engine.state.mode = 'down';
    this.engine?.clearImpedance();
    this.drive?.reset();
    this.idyn?.reset();
    this.inertia.reset();
    this.r.down = true;
    ctx.events.push({ kind: 'fall', corner: this.r.corner });
    return true;
  }

  /** This robot's parts touching the other robot right now (its skin: one contact scan, only when a hit is felt). */
  private touchingOpponent(ctx: SimContext): string[] {
    const out: string[] = [];
    const { mine, theirs } = this.skin;
    anyContact(ctx.data, (g1, g2) => {
      const p = theirs.has(g2) ? mine.get(g1) : theirs.has(g1) ? mine.get(g2) : undefined;
      if (p && !out.includes(p)) out.push(p);
      return false;
    });
    return out;
  }

  /** On the canvas: the scripted get-up owns the joints (a knocked-out robot just lies there). */
  private down(ctx: SimContext, s: Sense, dt: number): void {
    this.engineDrove = false;
    this.r.joints.forEach((j, i) => { this.qNow[i] = ctx.data.qpos[j.qadr] as number; });
    if (this.r.koReason) {
      this.gyro?.release(views(ctx).xfrc, this.ids.torso);
      this.skills.cancel(null, true);
      this.q.set(this.qNow); // out cold: no servo effort, only damping
      if (!this.r.down && this.getUp.detect(s, dt)) {
        this.r.down = true;
        ctx.events.push({ kind: 'fall', corner: this.r.corner });
      }
    } else {
      if (this.getUp.clip?.stage === 'crouch') this.crouchGyro(ctx, s, dt);
      else this.bleedGyro(ctx, s, dt);
      if (this.getUp.update(ctx, s, this.qNow, this.q, dt, this.fistsWorld(ctx))) {
        this.standFromCrouch(ctx, s);
        this.r.down = false;
        ctx.events.push({ kind: 'getup', corner: this.r.corner });
      }
    }
    if (this.getUp.holdingCatch) this.behaviours?.holdImpedance(true);
    else this.engine?.clearImpedance();
    // The get-up clip's drives track its motion instead of braking it (strike-power.md §2.1 burst, §4.6).
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    if (kv && this.getupSpeed.damp !== 1 && this.getUp.clip?.stage === 'play' && this.getUp.phase === 'clip') kv.fill(this.getupSpeed.damp);
    if (this.engine) this.engine.state.mode = 'down';
    // The get-up's targets pass through untouched (its own phases blend, and a clip aligns from the measured pose,
    // a jump the inertializer's arm and waist detector took for a switch and smoothed away: HAYMAKER handed over from
    // 25 → 31 of 34 recorded fall endings on the balance engine without it); running them through keeps the
    // inertializer current, so the switch to the standing posture is the one it smooths.
    this.inertia.reset();
    this.inertia.apply(this.q, dt);
    this.r.targets.set(this.q);
    this.report();
  }

  /**
   * On the canvas the gyro dumps the momentum it soaked up fighting the fall back into the body
   * (the canvas takes it). Otherwise it starts the rise saturated, and its desaturation torque
   * shoves the rising body the way it just fell. Going down it bleeds gently (the landing is not
   * thrown harder); once the pelvis is on the canvas it empties at its full torque, before the
   * get-up moves: emptied over 0.3 s it was still pushing the trunk back down through the first
   * second of the get-up, and SAVATE's sit-up off the back (140_08) fell back or stalled on 29 of 49
   * recorded fall endings on the legacy path, 9 of 49 emptied first (handed over to balance at
   * median 7.99 → 3.41 s); PYLON handed over 91 → 106 of 111. The torque is the core's own (capped
   * at GyroSpec.maxTorqueNm × health, and it costs battery like any other output).
   */
  private bleedGyro(ctx: SimContext, s: Sense, dt: number): void {
    const onCanvas = s.pelvisPos[2] < CANVAS_PELVIS * this.stance.pelvisHeight;
    this.gyro?.update(this.r, s.torsoRot, NO_TORQUE, dt, views(ctx).xfrc, this.ids.torso, true, onCanvas ? CANVAS_BLEED_S : DOWN_BLEED_S);
  }

  /**
   * Crouched over both feet on the way up: the gyro core helps carry the capture point over the
   * soles and tips the torso up (the same demand as standing balance, over the feet as they are).
   */
  private crouchGyro(ctx: SimContext, s: Sense, dt: number): void {
    if (!this.gyro) return;
    const soles = convexHull(SIDES.flatMap((side) => footCorners(this.geo, side, { x: s.feet[side].sole[0], y: s.feet[side].sole[1], yaw: s.feet[side].yaw })));
    const tilt = rotationError(s.torsoRot, rotZ(s.heading));
    const demand = this.balance.gyroDemand(s, [s.capture[0], s.capture[1]], soles, tilt, [0, 0]);
    this.gyro.update(this.r, s.torsoRot, demand, dt, views(ctx).xfrc, this.ids.torso, true);
  }

  private fistsWorld(ctx: SimContext): Record<Side, Vec3> {
    const v = views(ctx);
    return { l: readVec(v.xpos, this.ids.fist.l), r: readVec(v.xpos, this.ids.fist.r) };
  }

  /** Crouched over both feet: balance takes over and stands the robot up from here. */
  standFromCrouch(ctx: SimContext, s: Sense): void {
    this.r.joints.forEach((j, i) => { this.qNow[i] = ctx.data.qpos[j.qadr] as number; });
    this.gait.plantBoth(s);
    this.balance.reset();
    this.engine?.reset(s);
    this.inertia.mark();
    this.upperBody.reset();
    this.velFF.reset();
    this.idyn?.reset();
    const v = views(ctx);
    const toTorso = (b: number) => mulMtV(s.torsoRot, sub(readVec(v.xpos, b), s.torsoPos));
    this.rise.start(s, this.stance, this.qNow[this.jm.waistPitch], { l: toTorso(this.ids.fist.l), r: toTorso(this.ids.fist.r) });
  }

  private passive(ctx: SimContext): void {
    this.r.joints.forEach((j, i) => { this.r.targets[i] = this.r.design.stance[j.name] ?? 0; });
    this.gyro?.release(views(ctx).xfrc, this.ids.torso);
    this.engine?.clearImpedance();
  }

  /** Picks up the motion library once it is available (the worker loads it lazily). */
  private attachMocap(dt: number): void {
    if (this.mocap) return;
    this.mocapAge += dt;
    if (this.mocapAge < MOCAP_POLL_S) return;
    this.mocapAge = 0;
    this.mocap = mocapSet(this.r);
    if (!this.mocap) return;
    this.getUp.clip = new ClipGetUp(this.mocap, this.r, this.geo, this.stance);
    this.strikePlayer = new MotionPlayer(this.mocap, this.r.joints.length);
    this.footwork = new ClipFootwork(this.mocap, this.r.joints.length, this.geo, this.jm, this.stance);
    this.victory = new Victory(this.mocap, this.strikePlayer);
    registerMocapRanges(this.geo, this.mocap);
    this.engine?.attachMocap(this.mocap);
    const db = this.engine?.mocap?.db;
    if (db && MOCAP_STYLE.enabled) {
      const masses = { total: this.fullMass, upperLever: this.upperLever, arm: this.armMass };
      this.mocapStyle = new MocapStyle(this.mocap, this.geo, this.stance, this.jm, this.r.joints.length, db.idles[0] ?? null, masses);
    }
  }

  private refreshMass(ctx: SimContext, dt: number): void {
    this.massAge += dt;
    if (this.massAge < MASS_REFRESH_S) return;
    this.massAge = 0;
    this.mass = robotMass(views(ctx), this.ids); // parts can come off mid-fight
  }

  private setGuard(): void {
    for (const side of SIDES) {
      const arm = this.cmd.arms[side];
      arm.mode = 'fist';
      arm.fist = [...this.stance.guard[side].fist] as Vec3;
      arm.pole = [...this.stance.guard[side].pole] as Vec3;
    }
    this.cmd.neckYaw = -this.stance.pelvisYaw - this.stance.waistYaw;
  }

  /** On the gantry: hold the stance around a virtual pelvis at stance height. */
  private hang(s: Sense, bearing: number): void {
    const st = this.stance;
    this.heading = bearing;
    this.gait.resetAir({ x: s.pelvisPos[0], y: s.pelvisPos[1], heading: bearing });
    this.cmd.pelvisPos = [s.pelvisPos[0], s.pelvisPos[1], st.pelvisHeight];
    this.cmd.pelvisRot = rotZ(s.heading);
    for (const side of SIDES) this.gait.footCommand(side, this.gait.feet[side].place, 0, this.cmd.legs[side]);
    this.setGuard();
    this.cmd.waistYaw = st.waistYaw;
    this.cmd.waistPitch = st.waistPitch;
    this.balance.reset();
    this.engine?.reset(null);
  }

  private skillEnv(s: Sense): SkillEnv {
    const T = s.torsoRot, tp = s.torsoPos;
    return {
      s, geo: this.geo, stance: this.stance, opp: this.opp!, zone: 'head', aggression: this.r.intent?.aggression ?? 0.6,
      heading: this.heading, cmd: this.cmd, pose: this.pose, gait: this.gait,
      mocap: this.mocap, player: this.strikePlayer, jm: this.jm, rng: this.rng, engine: this.engine, dyn: this.drive?.dyn ?? null,
      toTorso: (p: Vec3) => mulMtV(T, sub(p, tp)),
      joint: (name: string) => {
        const i = this.r.jointIndex.get(name);
        return i === undefined ? undefined : this.r.joints[i];
      },
    };
  }

  private stand(ctx: SimContext, s: Sense, dt: number, bearing: number): void {
    const st = this.stance;
    this.heading = bearing;
    this.pose = neutralPose(st);
    this.setGuard();
    const env = this.skillEnv(s);
    this.celebrating = !this.rise.active && !this.skills.active() && !!this.victory?.available && ctx.robots.some((o) => o !== this.r && !!o.koReason);
    if (this.rise.active) this.rise.apply(this.pose, this.cmd, st, dt, this.riseRate(s));
    else if (this.celebrating) {
      this.goal = null;
      this.victory!.update(env, dt);
    } else {
      this.tactics.update(ctx, s, env);
      this.skills.update(ctx, env, dt);
    }
    // The balance engine stands the robot once it is up; the rise out of the get-up crouch stays
    // on the path it was built and tuned on (a folded body unfolding over planted feet), and the
    // engine starts over from the body as the rise ends.
    const wasDriving = this.engineDrove;
    this.engineDrove = !!this.engine && (!this.rise.active || this.getupSpeed.riseEngine > 0);
    if (this.engine && this.engineDrove) {
      if (!wasDriving) {
        this.engine.reset(s);
        this.inertia.mark();
      }
      this.standDcm(ctx, s, dt, bearing, env);
      const m = this.engine.state.mode;
      if (this.rise.active && (m === 'steady' || m === 'absorb' || m === 'recover')) this.engine.state.mode = 'rise';
      return;
    }
    if (this.engine && this.rise.active) this.engine.state.mode = 'rise';
    this.engine?.clearImpedance();
    this.decideSteps(s, env, dt);
    if (!this.skills.active()) this.footwork?.style(this.pose, this.cmd);
    const [wf, wl] = this.pose.weightShift;
    const shift = rot2(wf, wl, this.heading);
    const plan = this.gait.update(dt, s, this.cmd.legs, shift);
    this.comRef = plan.pos;
    // Integral trim while both feet bear weight (in single support the COP has too little room).
    const settled = (this.gait.phase === 'double' || this.gait.phase === 'shift') && this.gait.bothPlanted();
    const support = this.gait.supportPolygon();
    const [px, py] = this.balance.pelvisTarget(s, plan, dt, settled, this.rise.active ? RISE_OFFSET_TAU_S : undefined);
    this.plannedCop = this.balance.plannedCop(s, plan, support, this.gyro?.bleeding);
    this.dip += (this.gait.stepDip() - this.dip) * Math.min(1, dt / DIP_TAU_S);
    // Walking squares the hips up to the way it goes (a bladed pelvis walks crabwise).
    const blade = this.walker.active || (this.footwork?.active && this.footwork.walking) ? 0 : st.pelvisYaw;
    const yaw = this.yawTarget(s, reachablePelvisYaw(this.geo, this.gait, bearing + blade + this.pose.pelvisYaw));
    // Hip and waist strategy: bend toward the fall, hips back so the bend itself does not carry
    // the COM out with it (only its angular momentum acts).
    const bend = this.upperBody.update(s, support, s.heading, this.gyroHealth(), dt);
    const [bx, by] = rot2(-this.upperLever * (bend.pitch + bend.waist), this.upperLever * bend.roll, s.heading);
    this.cmd.pelvisPos = [px + bx, py + by, st.pelvisHeight - this.dip - this.pose.pelvisDrop];
    const hip = this.updateHipAssist(s, this.pose.waistPitch + bend.waist, dt);
    this.cmd.pelvisRot = mulMM(this.rise.rotation(yawPitchRoll(yaw, this.pose.pelvisPitch + bend.pitch, bend.roll + this.pose.pelvisRoll)), rotY(-hip));
    // The gyro holds the torso to the unbent attitude: its momentum is for the fall, not the bend.
    const unbent = mulMM(mulMM(this.rise.rotation(yawPitchRoll(yaw, this.pose.pelvisPitch, 0)), rotZ(this.pose.waistYaw)), rotY(this.pose.waistPitch));
    this.cmd.waistYaw = this.pose.waistYaw;
    this.cmd.waistPitch = this.pose.waistPitch + bend.waist;
    const capRef: P2 = [plan.pos[0] + plan.vel[0] / s.omega0, plan.pos[1] + plan.vel[1] / s.omega0];
    this.driveGyro(ctx, s, dt, capRef, this.gait.catchSupport(), unbent);
    this.probeLegacy(s, capRef);
  }

  /**
   * Standing on the balance engine (CONTROL.balance = 'dcm'): the engine plans the footsteps,
   * writes the legs, the pelvis position and the COP; the controller keeps the pelvis attitude,
   * the waist and the gyro.
   */
  private standDcm(ctx: SimContext, s: Sense, dt: number, bearing: number, env: SkillEnv): void {
    const st = this.stance;
    const e = this.engine!;
    const opp = this.opp!;
    this.measureGuard(s, dt);
    const [wf, wl] = this.pose.weightShift;
    const shift = rot2(wf, wl, this.heading);
    const spec = this.gyro?.spec;
    // comComp: the engine balances the body without the style layer's own COM shift.
    const sty = this.mocapStyle;
    const styled = !!sty && sty.w > 0 && MOCAP_STYLE.comComp > 0;
    const sb: Sense = styled ? this.styleFree(s, sty!.comShift, sty!.comShiftVel) : s;
    e.update(sb, dt, {
      goal: this.goal, bearing, oppDist: Math.hypot(opp.com[0] - s.com[0], opp.com[1] - s.com[1]),
      aggression: this.r.intent?.aggression ?? 0.5, speed: this.moveSpeed, walkEnd: this.walkEnd,
      holdFeet: this.skills.active() || this.pose.holdFeet || this.celebrating || this.strikePending, shift, allowCapture: this.rise.stepsAllowed(),
      gyroHealth: this.gyroHealth(), gyroSaturation: this.gyro?.saturation ?? 0,
      gyroTorqueNm: spec?.maxTorqueNm ?? 0, gyroMomentumNms: spec?.momentumNms ?? 1, legs: this.cmd.legs,
      threat: opp.windup, striking: !!this.skills.run && isStrikeSkill(this.skills.run.def), torsoUpCmd: this.torsoUpCmd, rising: this.rise.active,
    });
    // Bracing for a fall: whatever was being thrown is over (the hands go to the canvas).
    const react = e.reactions;
    if (react.mode === 'brace' && this.skills.active()) this.skills.cancel(env, true);
    // A capture step drops the skill, except a driven punch (mocap/strikes.ts) cocked or flying: a fist
    // in flight finishes the blow while the feet catch the body (pulling it back mid-flight does not help
    // them), and a cocked one thrown on the walk's step rides out one catch step and flies only once the
    // stance has settled.
    const run = this.skills.run;
    if (e.captured && run) run.scratch.capSeen = ((run.scratch.capSeen as number | undefined) ?? 0) + 1;
    const cocked = run?.phase === 'windup' && STRIKE_P3.flyThroughCapture > 1 && !!run.scratch.rideCapture && ((run.scratch.capSeen as number | undefined) ?? 0) <= 1;
    const keep = run && run.def.clip && run.def.kind === 'arm' && (run.phase === 'strike' || cocked);
    if (e.captured && !(STRIKE_P3.flyThroughCapture && keep)) this.skills.cancel(env, true);
    // The striking chain tracks the blow's velocity instead of braking it (strike-drive.ts).
    this.drive?.impedance(this.skills.run, this.plantedFn, dt);
    // The reaction's stiffness on top: the absorbing chain, the brace, the pre-brace (behaviours.ts).
    this.behaviours!.impedance(react, this.gait, this.skills.active());
    // Mocap style (arms, waist, pelvis bob, tilt and sway from the clip the feet are taking, or the
    // guard idle), only while nothing else owns the body.
    if (styled) {
      // The tools measure the real DCM (the style's shift included).
      this.probe.xi[0] += sty!.comShift[0] + sty!.comShiftVel[0] / s.omega0;
      this.probe.xi[1] += sty!.comShift[1] + sty!.comShiftVel[1] / s.omega0;
    }
    if (sty) {
      const m = e.mocap;
      const on = !this.skills.active() && !this.pose.holdFeet && !this.celebrating && react.mode !== 'brace';
      sty.apply(this.pose, this.cmd, dt, on, m?.clip ?? null, m?.tau ?? 0, this.r.intent?.aggression ?? 0.5, s.torsoRot, s.heading);
      if (sty.w > 0) this.probe.styleTime += dt;
    }
    // Phase 4: the reaction's arms, waist and posture (hands out to the canvas in a brace, the pelvis
    // lower while recovering or pre-braced).
    this.behaviours!.pose(react, s, this.pose, this.cmd, dt);
    // The trunk style (dip, pelvis tilt, waist bend) at accelerations the feet can carry (trunk-limit.ts):
    // a punch's clip played fast no longer lifts the soles off the canvas. A brace and the rise pass through.
    const ts = this.trunkStyle;
    ts.pelvisDrop = this.pose.pelvisDrop;
    ts.pelvisPitch = this.pose.pelvisPitch;
    ts.pelvisRoll = this.pose.pelvisRoll;
    ts.waistBend = this.pose.waistPitch - st.waistPitch;
    // (A kick's counter-lean is the reaction to its own leg, timed with it: it passes through too.)
    const kicking = this.skills.run?.def.kind === 'leg' || this.gait.phase === 'shift' || this.gait.phase === 'skill';
    this.trunkLimit!.apply(ts, dt, react.mode === 'brace' || this.rise.active || kicking);
    this.pose.pelvisDrop = ts.pelvisDrop;
    this.pose.pelvisPitch = ts.pelvisPitch;
    this.pose.pelvisRoll = ts.pelvisRoll;
    this.pose.waistPitch = st.waistPitch + ts.waistBend;
    // Walking squares the hips to the travel; over the last two steps they turn back to the blade.
    const want = e.walking() ? e.planner.travel : bearing + st.pelvisYaw + this.pose.pelvisYaw;
    const yaw = this.yawTarget(s, reachablePelvisYaw(this.geo, this.gait, want), true);
    // Hip and waist bend (with the gyro damaged, or recovering with its reserve low): attitude only; the
    // soles carry the COM.
    const reserve = this.gyro ? 1 - this.gyro.saturation : 0;
    const bendHealth = REACTIONS.enabled && react.mode === 'recover' && reserve < REACTIONS.bendReserve ? Math.min(this.gyroHealth(), 0.1 + 0.4 * (reserve / REACTIONS.bendReserve)) : this.gyroHealth();
    const bend = this.upperBody.update(s, this.gait.supportPolygon(), s.heading, bendHealth, dt);
    this.cmd.pelvisPos = [e.pelvis[0], e.pelvis[1], st.pelvisHeight - this.pose.pelvisDrop];
    const hip = this.updateHipAssist(s, this.pose.waistPitch + bend.waist, dt);
    this.cmd.pelvisRot = mulMM(this.rise.rotation(yawPitchRoll(yaw, this.pose.pelvisPitch + bend.pitch, bend.roll + this.pose.pelvisRoll)), rotY(-hip));
    this.cmd.waistYaw = this.pose.waistYaw + this.updateCounterYaw(ctx, dt);
    this.cmd.waistPitch = this.pose.waistPitch + bend.waist;
    // The torso's commanded up axis (pelvis attitude, then the waist): next tick's reactions judge the lean beyond it.
    const tr = mulMM(mulMM(this.cmd.pelvisRot, rotZ(this.cmd.waistYaw)), rotY(this.cmd.waistPitch));
    this.torsoUpCmd[0] = tr[2];
    this.torsoUpCmd[1] = tr[5];
    this.torsoUpCmd[2] = tr[8];
    if (this.gyro) this.gyro.update(this.r, s.torsoRot, e.gyro.demand, dt, views(ctx).xfrc, this.ids.torso, true, e.gyro.bleedS, e.gyro.bleedMaxNm);
    // The soles carry the gyro's bleed: a couple held by the ground moves the COP by τ/(m·g).
    const mg = s.mass * GRAVITY;
    const b = this.gyro?.bleeding;
    const want2: P2 = [e.cop[0] + (b ? b[1] / mg : 0), e.cop[1] - (b ? b[0] / mg : 0)];
    const support = this.gait.supportPolygon();
    this.plannedCop = support.length >= 3 ? clampToPolygon(support, want2) : want2;
    this.comRef = [e.state.xiRef[0], e.state.xiRef[1]];
    this.probe.cop[0] = this.plannedCop[0];
    this.probe.cop[1] = this.plannedCop[1];
  }

  /** The sense with the COM (and its velocity and capture point) moved back by the style's shift. */
  private styleFree(s: Sense, shift: P2, vel: P2): Sense {
    const com: Vec3 = [s.com[0] - shift[0], s.com[1] - shift[1], s.com[2]];
    const comVel: Vec3 = [s.comVel[0] - vel[0], s.comVel[1] - vel[1], s.comVel[2]];
    return { ...s, com, comVel, capture: [com[0] + comVel[0] / s.omega0, com[1] + comVel[1] / s.omega0, 0] };
  }

  /** The waist's counter-rotation this tick (COUNTER_YAW), rad. */
  private updateCounterYaw(ctx: SimContext, dt: number): number {
    const C = COUNTER_YAW;
    const on = !this.skills.active() && !this.pose.holdFeet && C.gain > 0;
    const pelvisYawRate = on ? views(ctx).cvel[this.ids.pelvis * 6 + 2] : 0;
    this.counterYaw += (C.gain * pelvisYawRate - this.counterYaw / C.leakS) * dt;
    this.counterYaw = clamp(this.counterYaw, -C.maxRad, C.maxRad);
    return this.counterYaw;
  }

  /** Tool probe for the legacy path: the planned COP, the plan's capture point, the footsteps. */
  private probeLegacy(s: Sense, capRef: P2): void {
    const p = this.probe;
    p.cop[0] = p.cmp[0] = this.plannedCop[0];
    p.cop[1] = p.cmp[1] = this.plannedCop[1];
    p.xi[0] = s.capture[0];
    p.xi[1] = s.capture[1];
    p.xiRef[0] = capRef[0];
    p.xiRef[1] = capRef[1];
    if (this.gait.stepsTaken !== p.touchdowns) {
      p.touchdowns = this.gait.stepsTaken;
      p.reserveAtTouchdown = 1 - (this.gyro?.saturation ?? 1);
    }
  }

  /**
   * Pelvis pitch back (rad) that carries a sagging torso on the hips: the waist's lag behind
   * `waistCmd` past a deadband, filtered. Only while rising or with a damaged waist (a healthy
   * waist's lag in a strike is motion, not sag).
   */
  private updateHipAssist(s: Sense, waistCmd: number, dt: number): number {
    const weak = this.rise.active || this.r.joints[this.jm.waistPitch].state !== 'ok';
    const want = weak ? clamp(s.waistPitch - waistCmd - HIP_ASSIST_DEADBAND, 0, HIP_ASSIST_MAX) : 0;
    this.hipAssist += (want - this.hipAssist) * Math.min(1, dt / HIP_ASSIST_TAU_S);
    return this.hipAssist;
  }

  /** Rise pacing: full speed with the capture point over the feet, near pause once it wanders off. */
  private riseRate(s: Sense): number {
    const out = this.gait.supportDistance([s.capture[0], s.capture[1]]);
    if (!Number.isFinite(out)) return 1;
    return clamp(1 - (out + RISE_SLOW_INSIDE_M) / (RISE_SLOW_INSIDE_M + RISE_PAUSE_OUTSIDE_M), RISE_MIN_RATE, 1);
  }

  /** 1 = an intact gyro core, 0 = destroyed or absent. */
  private gyroHealth(): number {
    return this.gyro ? clamp(this.r.gyro?.health ?? 0, 0, 1) : 0;
  }

  private yawTarget(s: Sense, want: number, dcm = false): number {
    const both = this.gait.bothPlanted();
    const lead = dcm ? (both ? YAW_TUNING.dcmLeadDouble : YAW_TUNING.dcmLeadSingle) : both ? YAW_TUNING.leadDouble : YAW_TUNING.leadSingle;
    return s.heading + clamp(wrapAngle(want - s.heading), -lead, lead);
  }

  private decideSteps(s: Sense, env: SkillEnv, dt: number): void {
    const gait = this.gait;
    if (gait.airborne()) return;
    // Clip footwork catches the body with its own next step; only a real stumble (the capture
    // point well past the feet) hands the feet back to the capture stepping.
    const footwork = this.footwork?.active ? this.footwork : null;
    if (footwork && gait.supportDistance([s.capture[0], s.capture[1]]) > YAW_TUNING.stumbleM && gait.phase === 'double') footwork.cancel(gait, 'stumble');
    // A walk plans every step on the capture point itself: its steps are not capture steps.
    if (!gait.walking && !this.footwork?.active && this.rise.stepsAllowed() && captureStep(gait, this.geo, s)) {
      this.walker.cancel();
      gait.captureSteps++;
      return;
    }
    if (skillCaptureStep(gait, this.geo, s, this.kickInFlight())) {
      gait.captureSteps++;
      this.skills.cancel(env, true);
      return;
    }
    if (!gait.walking) adjustSwing(gait, this.geo, s, !this.footwork?.active);
    // Feet stay planted while a skill runs (kicks borrow a leg through the gait).
    if (this.skills.active() || this.pose.holdFeet) {
      if (this.walker.active) this.walker.cancel();
      this.footwork?.cancel(gait, 'skill');
      return;
    }
    // Covering ground with the library's shuffles and walks.
    if (this.footwork && (this.footwork.active || this.footwork.wants(gait, this.goal))) {
      if (this.footwork.update(s, gait, this.goal, this.heading, this.r.intent?.aggression ?? 0.5, dt)) return;
    }
    // Covering ground: walk (the COM keeps travelling) until close, then square up in stance.
    if (FAST_WALK_ENABLED && (this.walker.active || this.walker.wants(s, this.goal, s.heading - this.stance.pelvisYaw))) {
      if (this.walker.update(s, this.goal, this.walker.params(this.walkSpeed(), this.gyroAssistM(s)), dt)) return;
    }
    const cur = gait.bothPlanted() ? gait.currentFrame() : null;
    if (!cur) return;
    const want = this.goal ?? { x: cur.x, y: cur.y, heading: this.heading };
    const side = planStep(gait, this.geo, want, this.timing, this.lastStepSide, this.goal ? MOVE_TOL : HOLD_TOL);
    if (side) this.lastStepSide = side;
  }

  /**
   * How far the gyro core can shift the pressure point for a walk right now: its torque over m·g,
   * scaled back as its rotor fills (it must keep momentum in hand for a real fall).
   */
  private gyroAssistM(s: Sense): number {
    if (!this.gyro) return 0;
    const free = clamp(1 - this.gyro.saturation / WALK_ASSIST_SAT, 0, 1);
    return (WALK_ASSIST_SHARE * this.gyro.spec.maxTorqueNm * this.gyroHealth() * free) / (s.mass * GRAVITY);
  }

  /** Walking pace: brisker with aggression, faster still for a sprinter's legs. */
  private walkSpeed(): number {
    const a = this.r.intent?.aggression ?? 0.5;
    return WALK_SPEED * (0.8 + 0.4 * a) * (this.r.design.abilities.includes('sprint') ? SPRINT_FACTOR : 1);
  }

  private driveGyro(ctx: SimContext, s: Sense, dt: number, capRef: P2, support: P2[], desiredTorso: Mat3): void {
    if (!this.gyro) return;
    const tilt = rotationError(s.torsoRot, desiredTorso);
    const roll = soleRoll(this.gait, s, footLoads(this.geo, this.gait, s, this.plannedCop));
    const demand = this.balance.gyroDemand(s, capRef, support, tilt, roll);
    if (this.gait.walking) {
      // The walk's pressure point beyond the sole: COP shift Δ ⇒ torque m·g·(Δy, −Δx, 0).
      const mg = s.mass * GRAVITY;
      demand[0] += mg * this.walker.assist[1];
      demand[1] -= mg * this.walker.assist[0];
    }
    this.gyro.update(this.r, s.torsoRot, demand, dt, views(ctx).xfrc, this.ids.torso, true);
  }

  /** Publish what the body is doing for telemetry and the opponent's reflexes. */
  private report(): void {
    const run = this.skills.run;
    if (this.r.koReason) this.r.skill = 'out';
    else if (this.getUp.active) this.r.skill = this.getUp.skillName;
    else if (this.rise.active) this.r.skill = 'getup_rise';
    else if (this.celebrating) this.r.skill = 'victory';
    else this.r.skill = run ? run.def.id : this.gait.phase === 'double' ? 'stance' : 'step';
    this.r.skillPhase = this.skills.progress();
    this.r.windup = this.skills.windup();
  }

  /**
   * Steady enough to throw from a set stance: torso upright, capture point inside the feet and the
   * gyro with momentum in hand (on the balance engine: its `steady`). A fighter off balance recovers
   * before it throws. The referee's FIGHT test reads this too.
   */
  readyToStrike(): boolean {
    const s = this.lastSense;
    if (!s || this.rise.active) return false;
    if (this.engine) return s.upright > STRIKE_UPRIGHT && this.engine.state.steady;
    return s.upright > STRIKE_UPRIGHT && this.balanceMargin() > STRIKE_MARGIN && (this.gyro?.saturation ?? 0) < STRIKE_MAX_SAT;
  }

  /**
   * An arm strike may start now from the footing the body has (the balance engine's canStrike: also
   * still moving with the DCM settled inside the soles, or from a step whose landing catches it).
   * The legacy path throws only from a set stance (readyToStrike, both feet planted).
   */
  canStrikeNow(): boolean {
    const s = this.lastSense;
    if (!s || this.rise.active) return false;
    if (this.engine) return s.upright > STRIKE_UPRIGHT && this.engine.state.canStrike;
    return this.gait.phase === 'double' && this.gait.bothPlanted() && this.readyToStrike();
  }

  /** Balanced enough to lend a leg to a kick (the balance engine's canKick; else as a strike). */
  readyToKick(): boolean {
    const s = this.lastSense;
    if (!s || this.rise.active) return false;
    if (this.engine) return s.upright > STRIKE_UPRIGHT && this.engine.state.canKick;
    return this.readyToStrike();
  }

  /** A mocap kick between lift-off and its impact (the leg is not reclaimed for a catch step yet). */
  private kickInFlight(): boolean {
    const run = this.skills.run;
    const clip = run?.scratch.clip as { stage?: string } | undefined;
    return !!run && run.def.kind === 'leg' && clip?.stage === 'kick' && !run.landed;
  }

  /** 1 = capture point well inside the feet and the gyro fresh; 0 = falling or down. */
  balanceMargin(): number {
    const s = this.lastSense;
    if (!s || this.r.down || this.getUp.active) return 0;
    if (this.engine) return this.engine.state.margin;
    const out = this.gait.supportDistance([s.capture[0], s.capture[1]]);
    const cp = Number.isFinite(out) ? clamp(0.5 - out / 0.2, 0, 1) : 0.3;
    return clamp(cp - 0.4 * (this.gyro?.saturation ?? 0), 0, 1);
  }
}
