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
import { clampToPolygon, convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from '../support';
import type { MocapSet } from '../mocap/library';
import { COM_REF, ComReference } from './com-ref';
import { DcmPlan, newDcmSample } from './dcm';
import { constrainFrom, FOOTWORK_TUNING, FootstepPlanner, pushCmp, soleCmp, type GaitKind, type PlanInput } from './footsteps';
import { GYRO_POLICY, gyroPolicy, newGyroCommand } from './gyro-policy';
import { FUTURE_S, MOCAP_STEPS, MocapSteps, type ClipFootstep } from './mocap-steps';
import { MOCAP_STYLE } from './mocap-style';
import { newRolloutResult, rollout } from './rollout';
import { newTakeoffState, planTakeoff, TAKEOFF, type TakeoffRequest } from './takeoff';
import { adjustSwing, captureStep, followCapture, STEP_ADJUST } from './step-adjust';
import { Impedance } from './impedance';
import { REACTIONS, Reactions } from './reactions';
import { Swing } from './swing';
import type { BalanceProbe, BalanceState } from './types';

export { CONTROL } from './config';
export type { BalanceProbe, BalanceState, Footstep } from './types';
export type { TakeoffRequest, TakeoffState } from './takeoff';

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
  liftCopOutM: 0.015, // a foot lifts once the planned COP is this close to the stance sole...
  liftCopWaitS: 0.06, // ...or once it has waited this long (the body is ready, the pressure lags). 0.12 smooths PYLON's angled approaches (tilt 12.6° → 7.2°) but stalls its backward step-drag (tests/control walk)
  captureUnloadS: 0.04, // ...and a capture step waits at most this long for it
  captureCopM: 0.015, // a capture step goes once the planned COP is this close to its stance sole
  earlyTouch: 0.75, // a swing touching down after this share of its time is planted
  earlyTouchWalk: 0.9,
  // ...a catch step only when it is also within this share of its step from the landing: a falling body
  // brings the canvas up to the foot early, and planted where it scuffed, a catch step lands short (in
  // sparring 54% of the catch steps that touched before 90% of their swing left the DCM outside the new
  // support, against 14% of those on time). Short of that the foot flies on to its landing.
  captureTouchShare: 0.25,
  lateTouchS: 0.12,
  touchdownM: 0.006, // sole this close to the canvas: contact
  liftedM: 0.01,
  kickPreW: 1.0, // weight onto the stance foot over this × 1/ω₀ before a kick (then KICK_GATE decides the lift)
  // Through a kick's weight shift the DCM feedback acts on this share of the body's own DCM error (the rest the
  // COM reference's, which the leash drags back with a body that lags it; 0: the reference alone). The leashed
  // reference lagged with a body that did not follow and the shift crept onto the stance sole too slowly for
  // the lift gate (a SAVATE front kick after a walk-in: the DCM 3.4 cm off at 0.6 s with 0, 2.2 cm with 1).
  kickBodyFeedback: 1,
  stanceAnkleKp: 0.3, // stance ankle gain scale (kv scales with its square root)
  stanceHipYawKp: 0.35, // stance hip yaw gain scale (§3.6: a pivot's 0.35)
  forceFF: 1, // share of the planned horizontal ground force fed forward through Jᵀ·F
  restShare: 0, // a planted foot carrying less of the weight than this rests where it is (0: never; resting the lightly loaded leg left the soles unable to shift the weight back, and a held stance drifted)
  captureErrM: 0.05, // moving: DCM error against the plan (plus half the gyro's reach) for a capture step
  trimTauS: 0.4, // holding still: the pelvis trim closes the body's DCM error to the plan at this rate...
  trimMaxM: 0.04, // ...by at most this much, and only below this error...
  trimSpeed: 0.1, // ...and this COM speed (m/s)
  // ...and through a kick's weight shift at this rate (0: not then). Measured at 0.15 and 0.08 s: the lift
  // gate then opened on bodies not ready for one foot (kick falls per 10: 2.1-3.8 on SAVATE and PYLON). Off.
  kickTrimTauS: 0,
  stableSpeed: 0.3, // m/s and rad/s: stable (Euphoria's thresholds)
  stableErrM: 0.05, // DCM error under this counts as stable
  steadyReserve: 0.6, // gyro momentum free to count as steady (§5.2: ready to throw from a set stance)...
  kickReserve: 0.6, // ...or to start a kick (a kicking leg's momentum is 40-60% of the rotor's)
  // Strikes from the current footing (the pace stage): an arm strike may also start on two feet with
  // the body still moving, once its DCM sits strikeInsideM inside the soles, the torso turns slower
  // than strikeRate and the DCM is within strikeErrM of its plan; or from a planned step (never a
  // capture step) whose touchdown is at most stepStrikeS away, when the DCM predicted at the
  // touchdown lies stepStrikeInsideM inside the support the landing makes (the blow lands with the foot).
  // A punch's pitch momentum is about 10 N·m·s (an arm of 4-10 kg at 2-5 m/s, 0.4 m above the COM),
  // 15-20% of the rotor's: strikeReserve leaves the rest of the rotor for a fall.
  strikeReserve: 0.4,
  strikeInsideM: 0.02,
  strikeRate: 0.5,
  strikeErrM: 0.12,
  stepStrikeS: 0.4,
  stepStrikeInsideM: 0.02,
  // Recovering (reactions.ts 'recover': after a hit or a catch step, until stable for a moment) an arm
  // strike may still start once the body is settled on two planted feet with its DCM this far inside the
  // soles and its COM slower than recoverStrikeSpeed (a fighter knocked back a step countering off the
  // landing). Off (speed 0): measured in 64 sparring fights it cut idle in range 54% → 48% but the
  // counters thrown off a body still recovering raised the self-falls 44 → 56 (the 'recover' gate held
  // 17% of the idle time without it).
  recoverStrikeInsideM: 0.04,
  recoverStrikeSpeed: 0,
  copSlewM: 0.018, // the planned COP (and the ground force's CMP) moves at most this far per control tick
  noPickS: 0.6, // a clip step that waited out liftWaitS blocks mocap picks this long
  resquareS: 0.3, // holding position, a stance knocked out of shape is re-formed only after this long stable
  recoverSettle: 1, // ...and recovering (reactions 'recover'), no planned step either until then (0: off)
  stallCapture: 1, // a lift that stalled liftWaitS with the DCM outside the soles becomes a catch step (0: re-plan)
  // Recovering on two feet after a hit or a catch step (reactions.ts 'recover'): the DCM feedback's gain ×
  // this, so the body is brought to rest over its new stance sooner (the COP stays inside the soles).
  recoverKp: 1,
};

/**
 * The kick gate (docs/design/balance-engine.md §5.3), exported so tools can sweep it. The weight goes
 * onto the stance foot over kickPreW/ω₀ (the DCM plan's CMP slides onto that sole), then the leg lifts
 * only when the DCM sits within xiM of that CMP, the body is stable (Euphoria's 0.3 m/s and rad/s), the
 * stance sole is flat, its leg's joints are healthy and the gyro's free momentum covers the kick's
 * (the centroid table's peak angular momentum at the rate it will play). Not ready waitS after the
 * pre-position: the kick is called off (the fighter's mind sees a cancelled kick, not a fall).
 */
export const KICK_GATE = {
  minPre: 0.8, // × kickPreW/ω₀ of weight shift before a lift
  xiM: 0.02,
  // > 0: the DCM anywhere on the stance sole shrunk by this also passes (0: only within xiM of its centre). The
  // sole's COP holds a DCM it lies over; the margin is the room left for the kick's own push. Within 2 cm of the
  // centre only, the procedural low kicks after a walk-in never lifted (FIRECRACKER 0/11, HAYMAKER 0/7 in the
  // strike drill --approach); with 0.03, 10/11 and 7/7 landed clean, no falls.
  soleM: 0.03,
  flat: 0.97,
  waitS: 0.3,
  // The momentum the gyro must have free (mocap/strikes.ts kickClip): this share of the centroid table's
  // peak (the actor's whole body turning; the robot's feet stay planted and its trunk turns a share),
  // less what the stance sole carries over the leg's flight (m·g·(half-width − soleMarginM)·flight).
  momentumShare: 0.6,
  soleMarginM: 0.02,
  outM: 0.02, // the DCM this far outside both soles during the shift calls the kick off at once
};

/**
 * A blow's step-in (requestLunge; docs/design/strike-power.md §2.6), exported so tools can sweep it:
 * the stride's limits, the swing's, and how long the lunging foot may take to unload.
 */
export const LUNGE = {
  maxStride: 0.3, // × leg length
  minM: 0.04, // a shorter step-in is not taken
  minSwingS: 0.14,
  maxSwingS: 0.32,
  unloadS: 0.06, // the foot lifts once the pressure is off it, or after this long
  pushShare: 0.6, // the rear sole pushes from at most this share of its half-length toward the travel
  frontShare: 0.7, // after the landing the CMP goes this share of the way from the rear foot to the front one
  maxStanceShare: 1.3, // the front foot lands at most this × the stance's length ahead of the rear one
};

export interface EngineInput {
  goal: StanceFrame | null;
  bearing: number;
  oppDist: number;
  aggression: number;
  speed: number | null;
  /** Ring IQ: a walk toward the opponent ends this far from him (m, COM to COM; 0: at the goal). */
  walkEnd?: number;
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
  /** Phase 4 (reactions.ts): the opponent's windup when he is within reach with a strike (0..1)... */
  threat?: number;
  /** ...and whether this body is throwing one itself (its lean is on purpose; no pre-brace). */
  striking?: boolean;
  /** The torso's up axis as last commanded (world; the reactions judge only the lean beyond it). */
  torsoUpCmd?: readonly number[];
  /** Standing up out of the get-up crouch (the COM is low on purpose). */
  rising?: boolean;
}

const ZERO: P2 = [0, 0];

export class BalanceEngine {
  readonly dcm = new DcmPlan();
  readonly planner: FootstepPlanner;
  readonly swing = new Swing();
  readonly ref = newDcmSample();
  readonly state: BalanceState = {
    xi: [0, 0], xiRef: [0, 0], margin: 1, gyroReserve: 1, torqueReserve: 1, mode: 'steady', clipRate: 1, clipSync: { hold: false },
    steady: false, canStrike: false, canKick: false, xiTouch: [0, 0], touchIn: -1,
  };
  readonly gyro = newGyroCommand();
  /** The COM the posture tracks (an inverted pendulum under the CMP the soles can make). */
  readonly com = new ComReference();
  /** Horizontal pelvis target. */
  readonly pelvis: P2 = [0, 0];
  /** COP the soles are asked for (the controller adds the gyro's bleed). */
  readonly cop: P2 = [0, 0];
  /** The CMP the soles deliver for the COM (the COP, slewed with it). */
  readonly cmpSoles: P2 = [0, 0];
  /** Last tick's COP and CMP for the soles (their slew limit). */
  private readonly copPrev: P2 = [0, 0];
  private readonly cmpPrev: P2 = [0, 0];
  private slewPrimed = false;
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
  /** A capture step waiting for its foot to unload, and since when. */
  private captureSide: Side | null = null;
  private captureSince = 0;
  private readonly xiM: P2 = [0, 0];
  /** Pelvis trim while holding still (the servos hold the body wherever it settled). */
  private readonly trim: P2 = [0, 0];
  /** COM velocity the controller works with: the rest of the body's while a leg swings. */
  private readonly vCtl: P2 = [0, 0];
  private readonly scratch = newDcmSample();
  private readonly tmpPlace: FootPlace = { x: 0, y: 0, yaw: 0 };
  /** Mocap footwork (Phase 5): motion-matched clip steps on the plan, and the style layer. */
  mocap: MocapSteps | null = null;
  private readonly dcmTry = new DcmPlan();
  private readonly pickSample = newDcmSample();
  private readonly future = new Float32Array(6);
  private readonly facing = new Float32Array(3);
  /** No mocap pick before this time (a clip step's lift that never came). */
  private noPickUntil = -Infinity;
  private readonly rollProc = newRolloutResult();
  private readonly rollClip = newRolloutResult();
  /** The kick under way needs this much free gyro momentum to lift its leg (N·m·s; the kick sets it). */
  kickNeedNms = 0;
  /** Kicks the gate called off (diagnostics). */
  kickCancels = 0;
  /** The gyro core's momentum capacity, N·m·s (from the controller every tick). */
  private gyroH = 1;
  /** A flashy move's take-off being prepared (takeoff.ts), and its readiness. */
  private takeoff: TakeoffRequest | null = null;
  private takeoffFresh = false;
  readonly takeoffState = newTakeoffState();
  /** A blow's step-in waiting for its foot to unload (requestLunge), and since when. */
  private lunge: { side: Side; place: FootPlace; land: number; since: number; ux: number; uy: number } | null = null;
  /** Step-ins taken, and the last one's stride (diagnostics). */
  lunges = 0;
  lastLungeM = 0;
  private settledSince = -1;
  /** The polygon the planned COP was kept inside this tick (the soles shrunk; the stance sole alone while a
   *  foot unloads to step): the feed-forward's soles stay inside it too. */
  copSupport: P2[] = [];
  /** How far the DCM sits outside the soles on two feet (m; ≤ 0 inside, 0 in single support). */
  private xiOutside = 0;
  /** A lift stalled with the DCM outside the support: the next capture check steps whatever the plan says. */
  private forceCapture = false;
  /** Per-joint gain and damping scales (impedance.ts). */
  private readonly impedance: Impedance;
  /** Phase 4: what the body is doing about a hit or a fall (absorb, recover, brace; reactions.ts). */
  readonly reactions: Reactions;
  private comMeasured = false;
  private readonly shareFn = (side: Side): number => this.loadShare(side);

  constructor(
    readonly geo: HumanoidGeometry,
    readonly stance: StanceParams,
    readonly gait: Gait,
    readonly jm: JointMap,
    private readonly r: RobotRuntime,
    readonly probe: BalanceProbe,
  ) {
    this.planner = new FootstepPlanner(geo, stance, gait);
    this.impedance = new Impedance(r, jm);
    // (The COM's standing height is refined from the body the first time it stands: reset.)
    this.reactions = new Reactions(geo, 0.5 * geo.height);
  }

  /** The design's motion library has loaded: footwork from its clips from now on. */
  attachMocap(set: MocapSet): void {
    // Off (SD_MOCAP_FOOTWORK=0): nothing of it runs, the engine is exactly the Phase 1 one.
    if (!MOCAP_STEPS.enabled && !MOCAP_STYLE.enabled) return;
    const m = new MocapSteps(set, this.geo, this.stance);
    this.mocap = m.db ? m : null;
  }

  /**
   * Flashy stage hook (§5.3): prepare a take-off from `req.support` at `req.at` with the COM moving at
   * `req.comVel`. The feet hold (no new steps); the plan shifts the weight onto the support sole and
   * ends with the DCM where that velocity puts it. False when the body is not on that foot (or both).
   */
  requestTakeoff(req: TakeoffRequest, now: number): boolean {
    const g = this.gait;
    if (!g.planted(req.support) || (g.phase !== 'double' && g.stanceSide() !== req.support)) return false;
    this.takeoff = { ...req, at: Math.max(req.at, now + TAKEOFF.minLeadS), comVel: [req.comVel[0], req.comVel[1]], lean: req.lean ? [req.lean[0], req.lean[1]] : undefined };
    this.takeoffFresh = true;
    this.mocap?.cancel();
    return true;
  }

  /**
   * A blow's step-in (strike-power.md §2.6: the lead foot timed to plant on the impact frame, the rear
   * leg pushing before the arm fires): from two planted feet, the front foot along `heading` (`side`
   * when they are level) steps `dist` forward (within LUNGE.maxStride and the legs' span), landing as
   * wide of the rear foot as its stance slot, at `landAt`.
   * The foot unloads first (the pressure goes onto the other sole), then swings while the rear sole
   * pushes (as hard as the DCM needs to arrive over the new stance, lungeTick), so the body arrives
   * moving into the blow; the landing is the step adjuster's, like any planned step. False when the
   * body is not settled on two planted feet (state.canStrike) or something else owns them (a kick's
   * shift, a take-off, a capture step, a swing), or the step would be too short to matter.
   */
  requestLunge(side: Side, dist: number, heading: number, landAt: number, now: number): boolean {
    const g = this.gait;
    if (g.phase !== 'double' || !g.bothPlanted() || this.takeoff || this.capturing || this.swing.active || this.lunge) return false;
    // Only from a settled stance (the DCM inside the feet with margin, the trunk still: canStrike from two
    // planted feet): a body still coming off the walk's last step has no push to spare (stepping again at
    // once braked it and swung its capture point out past the new stance into a catch step).
    if (!this.state.canStrike) return false;
    const ux = Math.cos(heading), uy = Math.sin(heading);
    // The foot nearer him steps (after a walk the stance's lead may be the one behind); `side` when level.
    const fl = g.feet.l.place, fr = g.feet.r.place;
    const ahead = (fl.x - fr.x) * ux + (fl.y - fr.y) * uy;
    if (Math.abs(ahead) > 0.02) side = ahead > 0 ? 'l' : 'r';
    const f = g.feet[side].place;
    // `dist` (within the stride) further along the heading than the foot stands now, and as wide of the
    // rear foot as the stance's own slot (a walk can leave the feet nearly in line: a blow thrown over
    // that base swings the capture point out sideways), within what the legs can span (the feet never cross).
    const d0 = Math.min(dist, LUNGE.maxStride * this.geo.legLength);
    const slot = g.partnerSlot(side, heading);
    // ...and never longer than maxStanceShare × the stance's own length (a walk can end in a long stance:
    // stepping on from it leaves a base the blow's turn and the target's push-back topple).
    const rear = g.feet[other(side)].place;
    const nominal = Math.abs(this.stance.slots.l.x - this.stance.slots.r.x);
    const along = Math.min(f.x * ux + f.y * uy + d0, rear.x * ux + rear.y * uy + LUNGE.maxStanceShare * nominal);
    const lat = -slot.x * uy + slot.y * ux;
    const want: FootPlace = { x: along * ux - lat * uy, y: along * uy + lat * ux, yaw: slot.yaw };
    const place = constrainFrom(this.geo, g.feet[other(side)].place, side, want, FOOTWORK_TUNING.maxSepL * this.geo.legLength);
    const d = (place.x - f.x) * ux + (place.y - f.y) * uy;
    if (d < LUNGE.minM) return false;
    this.lunge = { side, place, land: landAt, since: now, ux, uy };
    this.lastLungeM = d;
    this.mocap?.cancel();
    return true;
  }

  /** A step-in on its way (requested, waiting for its foot) or none. */
  get lunging(): boolean {
    return this.lunge !== null;
  }

  /** The step-in's foot lifts once it is unloaded; then the plan pushes off the rear sole into the landing. */
  private lungeTick(s: Sense): void {
    const L = this.lunge!;
    const g = this.gait;
    if (g.phase !== 'double' || !g.bothPlanted() || this.swing.active || this.takeoff) {
      this.lunge = null;
      return;
    }
    const stance = other(L.side);
    const inner = footCorners(this.geo, stance, g.feet[stance].place, BALANCE_TUNING.copShrinkM);
    if (polygonDistance(inner, this.cop).d > BALANCE_TUNING.captureCopM && s.time - L.since < LUNGE.unloadS) return;
    this.lunge = null;
    const t = s.time;
    const swing = clamp(L.land - t, LUNGE.minSwingS, LUNGE.maxSwingS);
    const lift = FOOTWORK_TUNING.walkLift * this.geo.legLength;
    if (!g.engineStep(L.side, L.place, swing, lift)) return;
    this.swing.start(t, g.feet[L.side].place, 0, L.place, swing, lift, BALANCE_TUNING.swingLeadS);
    this.swingSide = L.side;
    this.landNom = { ...L.place };
    this.capturing = false;
    this.captureSide = null;
    this.waitSince = -1;
    this.lunges++;
    this.probe.lifts++;
    // The plan: the rear sole pushes from its ball while the foot is in the air, then the CMP slides
    // onto the new support's centre.
    const cmpNow: P2 = [0, 0];
    if (this.planned) this.dcm.cmpAt(this.planClock(t), cmpNow);
    else {
      cmpNow[0] = this.cop[0];
      cmpNow[1] = this.cop[1];
    }
    const rear = g.feet[stance].place;
    // The weight goes on onto the front foot (the blow's weight transfer), not just back to the middle:
    // the DCM should arrive there as the foot lands. The rear sole pushes only as hard as that takes from
    // where the DCM is now (ξ(T) = c + (ξ₀ − c)·e^{ωT}, so c = (ξ(T) − ξ₀·e^{ωT}) / (1 − e^{ωT})), at most
    // from its ball (pushShare) and at least from inside it: a body already coming forward off the walk's
    // own step is pushed less, or braked, so its DCM does not carry past the new stance into a capture step.
    const k = LUNGE.frontShare;
    const goal: P2 = [rear.x + (L.place.x - rear.x) * k, rear.y + (L.place.y - rear.y) * k];
    const E = Math.exp(s.omega0 * swing);
    const want: P2 = [(goal[0] - this.xiM[0] * E) / (1 - E), (goal[1] - this.xiM[1] * E) / (1 - E)];
    const push = clampToPolygon(footCorners(this.geo, stance, rear, BALANCE_TUNING.copShrinkM), want);
    const ball = pushCmp(this.geo, stance, rear, L.ux, L.uy, LUNGE.pushShare);
    const over = (push[0] - ball[0]) * L.ux + (push[1] - ball[1]) * L.uy;
    if (over > 0) {
      push[0] -= over * L.ux;
      push[1] -= over * L.uy;
    }
    this.dcm.clear();
    this.dcm.add(t, cmpNow[0], cmpNow[1]);
    this.dcm.add(t + Math.min(0.05, swing * 0.3), push[0], push[1]);
    this.dcm.add(t + swing, push[0], push[1]);
    this.dcm.add(t + swing + FOOTWORK_TUNING.finalDs / s.omega0, goal[0], goal[1]);
    this.dcm.solve(s.omega0);
    this.planner.count = this.planner.next = 0;
    this.planner.gait = 'drag';
    this.planner.gaitSince = t;
    this.holdPlan = false;
    this.planned = true;
    // The reference starts from the measured DCM (the push was sized from it) and blends onto the plan's:
    // a plan's own DCM now lies behind a body already coming forward, and tracking it would brake him.
    this.dcm.sample(t, this.scratch);
    this.blend[0] = this.xiM[0] - this.scratch.xi[0];
    this.blend[1] = this.xiM[1] - this.scratch.xi[1];
    this.blendT = t;
    this.lastPlanT = t;
  }

  /** A capture step is in the air (planned where the DCM will be, timed for the leg). */
  get catching(): boolean {
    return this.capturing && this.swing.active;
  }

  /** Recovering: a capture step in the air, or on two feet with the DCM outside the soles (STEP_ADJUST.captureOutM). */
  get recovering(): boolean {
    return this.catching || this.xiOutside > STEP_ADJUST.captureOutM;
  }

  /** The flashy stage dropped the take-off (not ready in time, or changed its mind). */
  cancelTakeoff(): void {
    if (!this.takeoff) return;
    this.takeoff = null;
    this.takeoffState.active = this.takeoffState.ready = false;
    this.planned = false;
  }

  /** The flight is over: plan from the body as it lands (the step adjuster and capture steps take over). */
  landed(s: Sense): void {
    this.takeoff = null;
    this.takeoffState.active = this.takeoffState.ready = false;
    this.reset(s);
  }

  /** The take-off plan, every tick while one is prepared: no steps, the reference fixed. */
  private planTakeoffTick(s: Sense): void {
    const tk = this.takeoff!;
    const t = s.time;
    const st = this.takeoffState;
    if (this.takeoffFresh) {
      this.takeoffFresh = false;
      const cmpNow: P2 = [this.xiM[0], this.xiM[1]];
      const oldXi: P2 = [this.xiM[0], this.xiM[1]];
      if (this.planned) {
        this.dcm.cmpAt(this.planClock(t), cmpNow);
        this.currentXiRef(t, oldXi);
      }
      const p = this.gait.feet[tk.support].place;
      const sole: P2 = [p.x + (tk.lean?.[0] ?? 0), p.y + (tk.lean?.[1] ?? 0)];
      planTakeoff(this.dcm, t, cmpNow, sole, tk.at, tk.comVel, s.omega0);
      this.dcm.sample(t, this.scratch);
      this.blend[0] = oldXi[0] - this.scratch.xi[0];
      this.blend[1] = oldXi[1] - this.scratch.xi[1];
      this.blendT = t;
      this.planner.count = this.planner.next = 0;
      this.planned = true;
      this.holdPlan = true;
      this.lastPlanT = t;
    }
    st.active = true;
    st.eta = tk.at - t;
    st.xiErr = Math.hypot(this.xiM[0] - this.state.xiRef[0], this.xiM[1] - this.state.xiRef[1]);
    const flat = this.gait.planted(tk.support) && s.feet[tk.support].flat > TAKEOFF.flat;
    st.ready = flat && Math.abs(st.eta) <= 0.05 && st.xiErr <= TAKEOFF.readyM && this.state.gyroReserve >= TAKEOFF.reserve;
    // Not launched well after its time: the move is off, back to the plan.
    if (st.eta < -0.3) this.cancelTakeoff();
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
    this.mocap?.cancel();
    this.takeoff = null;
    this.lunge = null;
    this.takeoffState.active = this.takeoffState.ready = false;
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
    this.captureSide = null;
    this.forceCapture = false;
    this.planner.reset(s?.time ?? 0);
    this.com.primed = false;
    this.slewPrimed = false;
    this.reactions.reset(s?.time ?? 0);
    if (s && !this.comMeasured && s.pelvisPos[2] > 0.9 * this.stance.pelvisHeight) {
      this.reactions.setStandingCom(s.com[2] - Math.min(s.feet.l.sole[2], s.feet.r.sole[2]));
      this.comMeasured = true;
    }
    if (s) {
      this.com.reset(s);
      this.cmp[0] = this.cop[0] = this.cmpSoles[0] = s.capture[0];
      this.cmp[1] = this.cop[1] = this.cmpSoles[1] = s.capture[1];
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
    this.gyroH = inp.gyroMomentumNms;
    if (!this.driveSet) this.setDrive(s);
    g.maintain(s);
    this.senseXi(s);
    // Phase 4: a hit, a recovery, a fall that can no longer be caught (reactions.ts). A brace takes the
    // feet off the plan: no new steps, no catch steps (the one in the air lands).
    const R = this.reactions;
    R.update(s, dt, {
      gait: g, recovering: this.recovering, gyroReach: inp.gyroHealth > 0 ? gyroReach(s, inp) : 0,
      threat: inp.threat ?? 0, oppDist: inp.oppDist, striking: !!inp.striking || g.phase === 'shift' || g.phase === 'skill', allowSteps: inp.allowCapture,
      touchdowns: this.probe.touchdowns,
      touch: g.phase === 'single' && g.swingSide && this.swing.active && this.state.touchIn >= 0 ? { xi: this.state.xiTouch, landing: this.swing.target, side: g.swingSide } : null,
      torsoUpCmd: inp.torsoUpCmd ?? null, rising: inp.rising,
    });
    if (R.mode === 'brace') inp = { ...inp, holdFeet: true, allowCapture: false };
    if (this.mocap) {
      const up = this.planner.upcoming();
      this.mocap.tick(s.time, dt, up ? up.lift : NaN);
      if (this.mocap.active) this.probe.clipTime += dt;
      if (this.mocap.following) this.probe.followTime += dt;
    }
    if (this.swing.active || this.planner.count > this.planner.next) this.probe.moveTime += dt;
    this.trackSettled(s);
    if (g.phase === 'double' && !g.bothPlanted()) {
      // Feet in the air (dropped off the gantry, not landed yet): hold on, wait for the canvas.
      this.idle(s, inp, dt);
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
    if (this.lunge && !kicking) this.lungeTick(s);
    if (this.takeoff && !kicking) this.planTakeoffTick(s);
    else if (kicking) {
      this.kick(s);
      this.planHold(s, inp, true);
    } else if (inp.holdFeet) {
      if (g.phase === 'double') this.planHold(s, inp, false);
      else if (touched || !this.planned) this.replan(s, inp);
    } else if (touched || this.needsPlan(s, inp)) {
      // Holding position after a shove, a catch step or a hit: the stance is re-formed only once the body
      // has settled (§6: re-square after 0.3 s stable); until then both feet stay down under the CMP. The
      // same while recovering with a goal to walk to (the fight-clean pass): planned right after a catch step
      // landed, the walk's next step lifted a foot from under a body still moving, and the DCM ran out of the
      // one sole left (in the fight drill, catch-step chains that had already caught the body went on from
      // there). A catch step still goes out whenever one is needed (capture() runs regardless).
      const recovering = REACTIONS.enabled > 0 && R.mode === 'recover' && T.recoverSettle > 0;
      if ((!inp.goal || recovering) && T.resquareS > 0 && g.phase === 'double' && g.bothPlanted() && !this.settledFor(s.time, T.resquareS)) this.planHold(s, inp, false);
      else this.replan(s, inp);
    } else if (this.holdPlan && g.phase === 'double') this.planHold(s, inp, false);
    // Lift-off when the plan says, if the body is ready.
    if (!kicking && !this.takeoff && !inp.holdFeet && g.phase === 'double' && g.bothPlanted()) this.maybeLift(s, inp);
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
    // A capture step's foot unloads first: while it waits to go, the pressure is kept on the stance
    // sole. A sole cannot leave the canvas with the pressure on it, and the COP must not jump across
    // the support as it does. (A planned step waits for the same in maybeLift.)
    const physical = shrunk;
    const unloading = this.unloadingFor();
    if (unloading) shrunk = footCorners(this.geo, unloading, g.feet[unloading].place, T.copShrinkM);
    // (The feed-forward keeps the soles' pressure inside this too: a foot unloading to step stays unloaded.)
    this.copSupport = shrunk;
    // The COM reference runs the DCM feedback law on itself, under a CMP the soles (and, past
    // them, the gyro) can deliver; the posture tracks it.
    const hasGyro = inp.gyroHealth > 0;
    const reach = hasGyro ? gyroReach(s, inp) : 0;
    // Outside a walk the CMP is also kept behind the body's own DCM (COM_REF.guardFromM).
    const kp = T.kp * (R.mode === 'recover' && g.phase === 'double' ? T.recoverKp : 1);
    const holding = this.planner.gait === 'hold' && !inp.holdFeet && g.phase === 'double' && g.bothPlanted() && !unloading;
    // A kick's weight shift too (both soles down, the plan sliding the DCM onto the stance sole): on the
    // reference's own DCM error the leash let the reference lag with the body, and a shift the body did not
    // follow stalled short of the lift gate (BALANCE_TUNING.kickBodyFeedback).
    const shifting = g.phase === 'shift' && g.bothPlanted();
    this.com.step(s, this.vCtl, dt, this.ref, this.state.xiRef, 1 + kp, shrunk, reach, this.cmp, this.cop, this.gyroShare, this.planner.gait !== 'walk' ? this.xiM : undefined, holding ? COM_REF.bodyFeedback : shifting ? T.kickBodyFeedback : 0);
    this.cmpSoles[0] = this.cop[0];
    this.cmpSoles[1] = this.cop[1];
    this.slewSoles(physical);
    const cop = this.cmpSoles;
    // Gyro: damping, the emergency remainder; bleed only on two feet with margin.
    const inside = support.length >= 3 ? -polygonDistance(support, this.xiM).d : -1;
    this.xiOutside = g.phase === 'double' && g.bothPlanted() ? -inside : 0;
    gyroPolicy(s.mass, s.com[2], s.torsoOmega, hasGyro ? this.gyroShare : ZERO, inp.gyroSaturation, inside, this.bleedShare(t), this.gyro, R.mode === 'recover' || R.mode === 'absorb');
    if (R.mode === 'brace' && hasGyro) braceGyro(s, inp, this.gyro.demand, this.gyro);
    // The step adjuster (in the air) and capture steps (on two feet).
    if (g.phase === 'single' && g.swingSide && this.swing.active) this.adjust(s, g.swingSide);
    else if (inp.allowCapture && g.phase === 'double' && g.bothPlanted()) this.capture(s, inp, this.forceCapture);
    if (g.phase !== 'double') this.forceCapture = false;
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
    this.writeImpedance(dt);
    this.report(s, inp, inside, ex, ey);
    this.wasHolding = this.holdPlan && g.phase === 'double';
    // The head stays locked on its target in the world while the body turns under it (gaze.ts).
    this.r.mem[GAZE_STABILIZE_KEY] = true;
  }

  /** Stable on two planted feet (Euphoria's 0.3 m/s and 0.3 rad/s) since when (-1: not now). */
  private trackSettled(s: Sense): void {
    const g = this.gait;
    const T = BALANCE_TUNING;
    const ok = g.phase === 'double' && g.bothPlanted() && Math.hypot(s.comVel[0], s.comVel[1]) < T.stableSpeed
      && Math.hypot(s.torsoOmega[0], s.torsoOmega[1]) < T.stableSpeed;
    if (!ok) this.settledSince = -1;
    else if (this.settledSince < 0) this.settledSince = s.time;
  }

  private settledFor(t: number, span: number): boolean {
    return this.settledSince >= 0 && t - this.settledSince >= span;
  }

  /** The stance side whose sole carries all the pressure now (a foot unloading to lift), or null. */
  private unloadingFor(): Side | null {
    const g = this.gait;
    if (g.phase !== 'double' || !g.bothPlanted()) return null;
    if (this.lunge) return other(this.lunge.side);
    return this.captureSide ? other(this.captureSide) : null;
  }

  /**
   * How much of the gyro's bleed the soles may carry now: on two feet, faded in over GYRO_POLICY.
   * bleedFadeS after a touchdown and out over it before the next lift-off (its torque moves the COP
   * by τ/(m·g), which must not jump when a foot comes up or down).
   */
  private bleedShare(t: number): number {
    const g = this.gait;
    if (g.phase !== 'double' || !g.bothPlanted()) return 0;
    const fade = GYRO_POLICY.bleedFadeS;
    const up = this.holdPlan ? null : this.planner.upcoming();
    const toLift = up ? up.lift - t : Infinity;
    return clamp(this.doubleSince / fade, 0, 1) * clamp(toLift / fade, 0, 1);
  }

  /**
   * The pressure the soles are asked for changes continuously (leg forces cannot step): the planned
   * COP and the CMP behind the ground force move at most copSlewM per tick toward this tick's
   * values (a touchdown that widens the support, a re-plan, a foot unloading), inside the soles that
   * bear weight. What the limit holds back this tick the DCM feedback asks for again the next.
   */
  private slewSoles(shrunk: P2[]): void {
    const m = BALANCE_TUNING.copSlewM;
    if (this.slewPrimed) {
      slewToward(this.cop, this.copPrev, m);
      slewToward(this.cmpSoles, this.cmpPrev, m);
      if (shrunk.length >= 3) {
        const a = clampToPolygon(shrunk, this.cop);
        this.cop[0] = a[0];
        this.cop[1] = a[1];
        const b = clampToPolygon(shrunk, this.cmpSoles);
        this.cmpSoles[0] = b[0];
        this.cmpSoles[1] = b[1];
      }
    }
    this.copPrev[0] = this.cop[0];
    this.copPrev[1] = this.cop[1];
    this.cmpPrev[0] = this.cmpSoles[0];
    this.cmpPrev[1] = this.cmpSoles[1];
    this.slewPrimed = true;
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
    const err = Math.hypot(this.state.xiRef[0] - this.xiM[0], this.state.xiRef[1] - this.xiM[1]);
    // A kick's weight shift too (both soles still down, the DCM sliding onto the stance foot): the last
    // centimetres are what the lift gate waits on (KICK_GATE.xiM), and the soft stance legs leave them.
    const shifting = g.phase === 'shift' && g.bothPlanted() && T.kickTrimTauS > 0;
    const k = Math.min(1, dt / (shifting ? T.kickTrimTauS : T.trimTauS));
    const still = err < T.trimMaxM && (shifting
      || (this.holdPlan && !skill && g.phase === 'double' && g.bothPlanted() && Math.hypot(s.comVel[0], s.comVel[1]) < T.trimSpeed));
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
    // Steps still to come toward a goal that is now where the feet already stand (tactics holds the
    // stance in range): drop them.
    if (moving && g.bothPlanted() && this.planner.upcoming()!.lift > s.time) {
      const f = g.currentFrame();
      if (Math.hypot(want.x - f.x, want.y - f.y) < FOOTWORK_TUNING.moveTol.pos && Math.abs(angleDiff(want.heading, f.heading)) < FOOTWORK_TUNING.moveTol.yaw) return true;
    }
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
    // A clip step whose lift never came (the body never got ready for it): the planner's own steps
    // for a while, not the same pick again.
    if (this.waitSince >= 0 && this.mocap?.active) this.noPickUntil = t + BALANCE_TUNING.noPickS;
    const pin: PlanInput = {
      time: t, omega: s.omega0, goal: inp.goal, bearing: inp.bearing, oppDist: inp.oppDist, aggression: inp.aggression,
      speed: inp.speed, cmpNow, shift: inp.shift, swing: sw, doubleS: this.doubleSince, fromRest, lastSide: this.lastLanded, xi: this.xiM,
      walkEnd: inp.walkEnd ?? 0,
      opp: Number.isFinite(inp.oppDist) ? [s.com[0] + inp.oppDist * Math.cos(inp.bearing), s.com[1] + inp.oppDist * Math.sin(inp.bearing)] : null,
    };
    const m = this.mocap;
    if (sw && m && m.active && m.inAir >= 0) {
      // A clip step in the air: the clip's steps still to come keep their rhythm from the real lift-off.
      m.retime(sw.land);
      this.planner.planClip(pin, this.dcm, m.steps, m.next, m.count);
    } else {
      this.planner.plan(pin, this.dcm);
      if (m) {
        // (Not to re-form a held stance: that is one step back into a slot, not a clip's phrase.)
        if (!sw && this.planner.gait !== 'hold' && this.planner.count > 0 && g.bothPlanted() && !this.capturing && (inp.goal || !FOOTWORK_TUNING.anchorHold)) this.pickClip(s, inp, pin, t < this.noPickUntil);
        else if (!sw || !m.following) m.cancel();
      }
    }
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
   * Mocap footwork: the motion-matching pick at a footstep event on two feet. The query's future is
   * the procedural plan's (the COM following its ξ_ref FUTURE_S / rate ahead, and its turn); a pick
   * is kept only if the plan with its steps starts where the body can follow (clipFits). Without
   * one the procedural plan stands.
   */
  private pickClip(s: Sense, inp: EngineInput, pin: PlanInput, blocked = false): void {
    const m = this.mocap!;
    const M = MOCAP_STEPS;
    const w = s.omega0;
    const rate = M.rateLo + (M.rateHi - M.rateLo) * clamp(inp.aggression, 0, 1);
    // The COM under the procedural plan: ċ = ω(ξ_ref − c), from the body now.
    const horizon = FUTURE_S[2] / rate;
    const n = 24, h = horizon / n;
    let cx = s.com[0], cy = s.com[1];
    let k = 0;
    for (let i = 1; i <= n && k < 3; i++) {
      this.dcm.sample(s.time + i * h, this.pickSample);
      cx += w * (this.pickSample.xi[0] - cx) * h;
      cy += w * (this.pickSample.xi[1] - cy) * h;
      while (k < 3 && i * h >= FUTURE_S[k] / rate - 1e-9) {
        this.future[2 * k] = cx - s.com[0];
        this.future[2 * k + 1] = cy - s.com[1];
        k++;
      }
    }
    const cur = this.gait.currentFrame();
    const turn = inp.goal ? angleDiff(inp.goal.heading, cur.heading) : 0;
    const span = Math.max(0.3, this.planner.finalTime - s.time);
    for (let i = 0; i < 3; i++) this.facing[i] = turn * clamp(FUTURE_S[i] / rate / span, 0, 1);
    // How well the body follows the procedural plan from here (the bar a clip plan must meet).
    this.rollPlan(s, this.dcm, this.rollProc);
    const saved = this.planner.saveArrival();
    let tried = false;
    const query = {
      s, time: s.time, omega: w, bearing: inp.bearing, aggression: inp.aggression, gait: this.gait, goal: inp.goal, opp: pin.opp,
      future: this.future, facing: this.facing, drive: this.planner.drive, fromRest: pin.fromRest, doubleS: this.doubleSince,
      allowPass: this.planner.gait === 'walk', lastLanded: this.lastLanded,
      accept: (steps: readonly ClipFootstep[], count: number) => {
        tried = true;
        this.planner.restoreArrival(saved);
        this.planner.planClip(pin, this.dcmTry, steps, 0, count);
        return this.clipFits(s, pin);
      },
    };
    // Walking stays on the procedural steps (MOCAP_STEPS.walkClips); the clip's clock follows them.
    const ok = !blocked && (this.planner.gait !== 'walk' || M.walkClips > 0) && m.pick(query);
    this.planner.restoreArrival(saved);
    if (ok) {
      this.planner.planClip(pin, this.dcm, m.steps, 0, m.count);
      this.probe.picks++;
    } else {
      // (A fallback: candidates were tried and none fit; the procedural plan is planned again.)
      if (tried) {
        this.probe.fallbacks++;
        this.planner.plan(pin, this.dcm);
      }
      m.follow(query);
    }
  }

  /**
   * Can the body follow the clip plan in dcmTry now? A rollout of the pendulum under the feedback
   * law with the CMP clipped into the soles (rollout.ts): its DCM error must stay within
   * MOCAP_STEPS.maxMismatchM, or no more than a centimetre above the procedural plan's.
   */
  private clipFits(s: Sense, pin: PlanInput): boolean {
    const M = MOCAP_STEPS;
    if (pin.fromRest && this.gait.bothPlanted()) {
      // From rest the plan starts at the body's own DCM (its first CMP knot, inside the soles).
      const poly = shrink(this.gait.supportPolygon(), BALANCE_TUNING.copShrinkM);
      this.dcmTry.connect(this.xiM, (p) => (poly.length >= 3 ? clampPoint(poly, p) : p));
    }
    const r = this.rollPlan(s, this.dcmTry, this.rollClip);
    const p = this.rollProc;
    const ok = r.maxErr <= Math.max(M.maxMismatchM, p.maxErr + 0.01) && r.saturated <= p.saturated + 0.05;
    this.mocap?.trace?.push(`${pin.time.toFixed(2)}   fits? clip err ${(r.maxErr * 100).toFixed(1)} cm sat ${r.saturated.toFixed(2)} s, procedural ${(p.maxErr * 100).toFixed(1)} cm sat ${p.saturated.toFixed(2)} s, v ${Math.hypot(s.comVel[0], s.comVel[1]).toFixed(2)}${ok ? '' : ' NO'}`);
    return ok;
  }

  /** The rollout of `plan` (the planner's current footsteps) from the body now (rollout.ts). */
  private rollPlan(s: Sense, plan: DcmPlan, out: ReturnType<typeof newRolloutResult>): ReturnType<typeof newRolloutResult> {
    const pl = this.planner;
    const g = this.gait;
    let end = s.time + 0.6;
    for (let i = 0; i < Math.min(pl.count, 2); i++) end = Math.max(end, pl.steps[i].land + 0.25);
    const horizon = Math.min(1.6, end - s.time);
    return rollout(this.geo, plan, pl.steps, pl.count, { l: g.feet.l.place, r: g.feet.r.place }, null,
      s.com, this.vCtl, s.omega0, 1 + BALANCE_TUNING.kp, s.time, horizon, 0.01, BALANCE_TUNING.copShrinkM,
      MOCAP_STEPS.dsReachHL * this.geo.legs.l.footHalfLength, this.doubleSince < MOCAP_STEPS.settleS ? this.lastLanded : null,
      MOCAP_STEPS.settleS - this.doubleSince, out);
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
      this.mocap?.cancel();
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
    const T = BALANCE_TUNING;
    const step = this.planner.upcoming();
    if (!step || this.holdPlan || s.time < step.lift) return;
    const g = this.gait;
    const stance = other(step.side);
    // The foot lifts once the body is ready for the stance sole (it holds the DCM, or the landing will
    // catch it) and the pressure is already on that sole: lifting a foot the controller still pushes
    // with would throw the COP across the support in one tick. While the trailing sole still pushes,
    // the plan's clock waits at the lift (planClock) and the feedback brings the pressure forward.
    const inner = footCorners(this.geo, stance, g.feet[stance].place, T.copShrinkM);
    const onStance = polygonDistance(inner, this.cop).d <= T.liftCopOutM;
    if (this.ready(s, step.side, step.place, step.land - step.lift) && (onStance || (this.waitSince >= 0 && s.time - this.waitSince >= T.liftCopWaitS))) {
      g.engineStep(step.side, step.place, step.land - step.lift, step.clearance);
      const fs = s.feet[step.side];
      this.swing.start(s.time, g.feet[step.side].place, Math.max(0, fs.height), step.place, step.land - step.lift, step.clearance, T.swingLeadS);
      this.swingSide = step.side;
      this.landNom = { ...step.place };
      this.planner.next++;
      this.probe.lifts++;
      if (step.source === 'clip' && step.clipIdx !== undefined && this.mocap) {
        this.mocap.onLift(step.clipIdx);
        this.probe.clipLifts++;
      } else if (this.mocap?.following) {
        this.mocap.followLift(step.side, s.time + (step.land - step.lift));
        this.probe.followLifts++;
      } else this.mocap?.cancel();
      this.waitSince = -1;
      // Re-time the plan from the real lift-off.
      this.replan(s, inp);
      return;
    }
    if (this.waitSince < 0) this.waitSince = s.time;
    else if (s.time - this.waitSince > T.liftWaitS) {
      // A lift that never came while the DCM ran out of the support (the planned landing does not catch it
      // and the stance sole cannot hold it): a catch step now (capture() goes on forcing it while its foot
      // unloads), not another plan that waits the same way.
      const support = g.supportPolygon();
      if (T.stallCapture && inp.allowCapture && support.length >= 3 && polygonDistance(support, this.xiM).d > STEP_ADJUST.captureOutM) {
        this.forceCapture = true;
        return;
      }
      this.replan(s, inp);
    }
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
    this.mocap?.cancel();
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
    let near = true;
    if (this.capturing && u < 1) {
      const fs = s.feet[side];
      const left = Math.hypot(sw.target.x - fs.sole[0], sw.target.y - fs.sole[1]);
      near = left <= BALANCE_TUNING.captureTouchShare * Math.max(0.05, Math.hypot(sw.target.x - sw.from.x, sw.target.y - sw.from.y));
    }
    if ((u > early && touching && f.lifted && near) || (u >= 1 && touching) || s.time > sw.t0 + sw.T + BALANCE_TUNING.lateTouchS) {
      g.engineTouchdown(side, s);
      sw.stop();
      // (A lift that was waiting before this step is history: the next plan starts from a landing,
      // not from rest.)
      this.waitSince = -1;
      this.mocap?.onTouchdown();
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
      if (followCapture(this.geo, this.gait, this.swing, side, this.xiM, s.omega0, s.time, s.heading)) this.gait.retargetSwing(this.swing.target);
      return;
    }
    this.dcm.sample(this.swing.t0 + this.swing.T, this.scratch);
    // The swing hip t from now: carried on by the body, which falls over the stance sole as an
    // inverted pendulum (c − p)(cosh ωt − 1) + (v/ω)·sinh ωt, not at its speed at lift-off (a
    // walk still gathering speed would otherwise see every planned landing out of reach).
    const hip = this.geo.legs[side].hip;
    const cy = Math.cos(s.heading), sy = Math.sin(s.heading);
    const hx = s.pelvisPos[0] + cy * hip[0] - sy * hip[1], hy = s.pelvisPos[1] + sy * hip[0] + cy * hip[1];
    const dx = s.com[0] - this.cmpSoles[0], dy = s.com[1] - this.cmpSoles[1];
    const vx = this.vCtl[0], vy = this.vCtl[1], w = s.omega0;
    const hipAt = (t: number): P2 => {
      const ch = Math.cosh(w * t) - 1, sh = Math.sinh(w * t) / w;
      return [hx + clamp(dx * ch + vx * sh, -0.6, 0.6), hy + clamp(dy * ch + vy * sh, -0.6, 0.6)];
    };
    const changed = adjustSwing(this.geo, this.gait, this.swing, side, {
      time: s.time, omega: w, decay: BALANCE_TUNING.kp * w, hipAt, hipReach: this.hipReach(side),
      xi: this.xiM, xiRef: this.state.xiRef, xiLand: this.scratch.xi, landNom: this.landNom,
      avail: [this.cmpSoles[0] - this.ref.r[0], this.cmpSoles[1] - this.ref.r[1]], short: [this.cmp[0] - this.cmpSoles[0], this.cmp[1] - this.cmpSoles[1]],
      heading: s.heading,
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

  private capture(s: Sense, inp: EngineInput, force = false): void {
    // Moving, the DCM runs ahead of the feet on purpose (the next step catches it): only an error
    // against the plan the soles and gyro cannot take back calls for a capture step (or a lift that
    // stalled with the DCM outside the support: `force`).
    const reach = gyroReach(s, inp);
    if (!force && !this.holdPlan && this.planner.upcoming()) {
      const e = Math.hypot(this.xiM[0] - this.state.xiRef[0], this.xiM[1] - this.state.xiRef[1]);
      if (e < BALANCE_TUNING.captureErrM + 0.5 * reach) return;
    }
    const plan = captureStep(this.geo, this.gait, s, reach, this.planner.drive, force);
    if (!plan) {
      this.captureSide = null;
      this.forceCapture = false;
      return;
    }
    const g = this.gait;
    // The stepping foot unloads first (a few ticks: the COP slews onto the stance sole).
    if (this.captureSide !== plan.side) {
      this.captureSide = plan.side;
      this.captureSince = s.time;
    }
    const inner = footCorners(this.geo, other(plan.side), g.feet[other(plan.side)].place, BALANCE_TUNING.copShrinkM);
    if (polygonDistance(inner, this.cop).d > BALANCE_TUNING.captureCopM && s.time - this.captureSince < BALANCE_TUNING.captureUnloadS) return;
    this.captureSide = null;
    this.forceCapture = false;
    this.waitSince = -1;
    this.mocap?.cancel();
    this.cancelTakeoff();
    const lift = STEP_ADJUST.captureLiftL * this.geo.legLength;
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

  /**
   * Kicks: the weight onto the stance foot (planHold slides the CMP onto that sole over kickPreW/ω₀),
   * then the leg is lent only when the body is ready for single support (KICK_GATE); a kick that is
   * not ready in time is called off.
   */
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
    const K = KICK_GATE;
    const p = g.feet[stance].place;
    const err = Math.hypot(this.xiM[0] - p.x, this.xiM[1] - p.y);
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    const rate = Math.hypot(s.torsoOmega[0], s.torsoOmega[1]);
    const stable = speed < BALANCE_TUNING.stableSpeed && rate < BALANCE_TUNING.stableSpeed;
    const flat = s.feet[stance].flat > K.flat;
    const m = this.jm.leg[stance];
    const healthy = [m.hipYaw, m.hipRoll, m.hipPitch, m.knee, m.anklePitch, m.ankleRoll].every((i) => this.r.joints[i].state === 'ok');
    const reserve = this.state.gyroReserve * this.gyroH >= this.kickNeedNms;
    // Over the stance foot: the DCM within xiM of the sole's centre, or (soleM > 0) anywhere on the sole
    // shrunk by soleM (the sole's COP holds a DCM it lies over; soleM is the room left for the kick's own push).
    const over = err <= K.xiM || (K.soleM > 0 && polygonDistance(footCorners(this.geo, stance, p, K.soleM), this.xiM).d <= 0);
    if (since >= K.minPre * T && over && stable && flat && healthy && reserve) {
      g.grantSkillLeg();
      this.kickSince = -1;
      return;
    }
    // The DCM running out of the soles during the shift: called off at once (the feet are free to catch it).
    const support = g.supportPolygon();
    const out = support.length >= 3 && polygonDistance(support, this.xiM).d > K.outM;
    if (out || since > T + K.waitS || since > g.shiftLimit()) {
      g.cancelShift();
      this.kickSince = -1;
      this.kickCancels++;
    }
  }

  // ---------------------------------------------------------------- output

  private idle(s: Sense, inp: EngineInput, dt: number): void {
    this.pelvis[0] = s.pelvisPos[0];
    this.pelvis[1] = s.pelvisPos[1];
    const l = this.gait.feet.l.place, r = this.gait.feet.r.place;
    this.cop[0] = this.cmp[0] = this.cmpSoles[0] = (l.x + r.x) / 2;
    this.cop[1] = this.cmp[1] = this.cmpSoles[1] = (l.y + r.y) / 2;
    this.gyroShare[0] = this.gyroShare[1] = 0;
    this.force[0] = this.force[1] = 0;
    this.slewPrimed = false;
    gyroPolicy(s.mass, s.com[2], s.torsoOmega, ZERO, inp.gyroSaturation, -1, 0, this.gyro);
    this.planned = false;
    this.com.reset(s);
    this.writeLegs(s, inp.legs);
    this.writeImpedance(dt);
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

  /**
   * Joint impedance (impedance.ts): stance legs soft (the feed-forward carries the load, the spring
   * only corrects), swing legs stiff, each foot's scales following the weight the plan puts on it.
   */
  private writeImpedance(dt: number): void {
    this.impedance.write(this.gait, this.shareFn, { ankle: BALANCE_TUNING.stanceAnkleKp, hipYaw: BALANCE_TUNING.stanceHipYawKp }, dt);
  }

  /** Back to the servos as built (legacy path, a knockout, the get-up). */
  clearImpedance(): void {
    this.impedance.clear();
  }

  /** The DCM predicted at the touchdown lies inside the support the landing makes (stance sole + landing sole, shrunk). */
  private landingCatches(): boolean {
    const g = this.gait;
    const side = g.swingSide;
    if (!side) return false;
    const m = BALANCE_TUNING.stepStrikeInsideM;
    const stance = other(side);
    const hull = convexHull([...footCorners(this.geo, stance, g.feet[stance].place, m), ...footCorners(this.geo, side, this.swing.target, m)]);
    return hull.length >= 3 && polygonDistance(hull, this.state.xiTouch).d <= 0;
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
    const mode = this.reactions.mode;
    st.mode = REACTIONS.enabled ? mode : this.probe.gait === 'capture' ? 'recover' : 'steady';
    // Reacting to a hit or a fall: no new blows until the body is its own again.
    const reacting = REACTIONS.enabled > 0 && (mode === 'absorb' || mode === 'recover' || mode === 'brace');
    const T = BALANCE_TUNING;
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    const rate = Math.hypot(s.torsoOmega[0], s.torsoOmega[1]);
    const err = Math.hypot(ex, ey);
    const stable = speed < T.stableSpeed && rate < T.stableSpeed && inside > 0 && err < T.stableErrM;
    const planted = g.phase === 'double' && g.bothPlanted();
    const noGyro = inp.gyroHealth <= 0;
    st.steady = planted && stable && !reacting && (noGyro || st.gyroReserve >= T.steadyReserve);
    const reserve = noGyro || st.gyroReserve >= T.strikeReserve;
    // Recovering, settled enough to counter: two planted feet, no catch step, the DCM well inside, the body slow.
    const recoveredEnough = mode === 'recover' && planted && !this.capturing && inside >= T.recoverStrikeInsideM && speed < T.recoverStrikeSpeed;
    const blocked = reacting && !recoveredEnough;
    // Where the DCM is heading: the swing's touchdown, with the CMP held where the stance sole has it.
    const tRem = g.phase === 'single' && g.swingSide && this.swing.active ? Math.max(0, this.swing.t0 + this.swing.T - s.time) : -1;
    st.touchIn = tRem;
    if (tRem >= 0) {
      const k = Math.exp(s.omega0 * tRem);
      st.xiTouch[0] = this.cmpSoles[0] + (this.xiM[0] - this.cmpSoles[0]) * k;
      st.xiTouch[1] = this.cmpSoles[1] + (this.xiM[1] - this.cmpSoles[1]) * k;
    } else {
      st.xiTouch[0] = this.xiM[0];
      st.xiTouch[1] = this.xiM[1];
    }
    const capturing = this.capturing || this.probe.gait === 'capture';
    // (Recovering, the DCM is judged against the body's support, not the plan it was knocked off.)
    const settled = planted && !capturing && inside >= T.strikeInsideM && rate < T.strikeRate && (err < T.strikeErrM || recoveredEnough);
    st.canStrike = !blocked && (st.steady || (reserve && rate < T.strikeRate && (settled || (!reacting && tRem >= 0 && tRem <= T.stepStrikeS && !capturing && this.landingCatches()))));
    st.strikeBlock = st.canStrike ? '' : blocked ? mode : !reserve ? 'gyro reserve' : rate >= T.strikeRate ? 'torso rate' : capturing ? 'catch step'
      : !planted ? 'step' : inside < T.strikeInsideM ? 'DCM near edge' : err >= T.strikeErrM ? 'DCM off plan' : 'other';
    st.canKick = st.steady && (inp.gyroHealth <= 0 || st.gyroReserve >= T.kickReserve) && s.feet.l.flat > 0.97 && s.feet.r.flat > 0.97;
    st.kickBlock = st.canKick ? '' : !planted ? 'step' : reacting ? mode : !(noGyro || st.gyroReserve >= Math.max(T.steadyReserve, T.kickReserve)) ? 'gyro reserve'
      : speed >= T.stableSpeed ? 'moving' : rate >= T.stableSpeed ? 'torso rate' : inside <= 0 ? 'DCM outside' : err >= T.stableErrM ? 'DCM off plan' : 'feet not flat';
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

/**
 * Bracing: the gyro core spends what it has slowing the body's tumble (pitch and roll), with no reserve
 * kept back and no bleed: the most it can do for the landing (§6). Its torque and momentum caps are the
 * core's own (gyro.ts).
 */
function braceGyro(s: Sense, inp: EngineInput, demand: number[], cmd: { bleedS: number; bleedMaxNm: number }): void {
  const tau = inp.gyroTorqueNm * inp.gyroHealth;
  const wx = s.torsoOmega[0], wy = s.torsoOmega[1];
  const n = Math.hypot(wx, wy);
  const k = tau / Math.max(n, REACTIONS.braceGyroRateRadS);
  demand[0] = -k * wx;
  demand[1] = -k * wy;
  demand[2] = 0;
  cmd.bleedS = Infinity;
  cmd.bleedMaxNm = 0;
}

/** Moves `p` from `prev` toward its value by at most `max` (in place). */
function slewToward(p: P2, prev: P2, max: number): void {
  const dx = p[0] - prev[0], dy = p[1] - prev[1];
  const d = Math.hypot(dx, dy);
  if (d <= max) return;
  p[0] = prev[0] + (dx * max) / d;
  p[1] = prev[1] + (dy * max) / d;
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
