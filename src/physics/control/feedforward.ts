// Feed-forward gravity compensation, delivered the only honest way a position servo allows:
// by shifting its target by τ/kp. For a static pose the joint torque that holds the robot is
//   τ = qfrc_bias − Jᵀ·F_ground
// where qfrc_bias is MuJoCo's gravity (+ Coriolis) load on that joint and F_ground is the
// planned ground reaction under each stance foot, acting at that foot's centre of pressure.
// For a hinge whose subtree holds the contact point p: (Jᵀ·F)_j = axis_j · ((p − anchor_j) × F).
import type { Vec3 } from '../../core/types';
import type { RobotRuntime } from '../sim-context';
import type { Side } from './geometry';
import { GRAVITY, type Views } from './sense';
import { clampToPolygon, polygonDistance, type P2 } from './support';

export interface JointInfo {
  index: number; // into r.joints / r.targets
  name: string;
  dof: number;
  jnt: number; // joint id (xanchor / xaxis rows)
  leg: Side | null; // stance-leg joints carry ground reaction
}

export interface FootLoad {
  share: number; // fraction of body weight on this foot, 0..1
  cop: Vec3; // centre of pressure, world
}

export function jointInfo(r: RobotRuntime, dofJnt: ArrayLike<number>): JointInfo[] {
  return r.joints.map((j, index) => {
    const legSide = /^(thigh|shin|foot)_([lr])$/.exec(j.part);
    return { index, name: j.name, dof: j.dadr, jnt: dofJnt[j.dadr], leg: legSide ? (legSide[2] as Side) : null };
  });
}

/** Servo gain actually in force (the motor system scales kp for limp and seized joints, and by
 *  the balance engine's per-joint gain scale). */
export function effectiveKp(r: RobotRuntime, index: number): number {
  const j = r.joints[index];
  if (j.state === 'limp') return 0;
  if (j.state === 'seized') return j.kp * 3;
  const scale = r.mem.gainScale as Float64Array | undefined;
  return scale ? j.kp * scale[index] : j.kp;
}

/**
 * Target shift that turns the servo's damping on `v` into damping on the tracking error: kd·v/kp,
 * with the damping actually in force. Evaluated as (kd·scale·v)/kp so that without the balance
 * engine's scales (the legacy path) the arithmetic is bit-for-bit what it was before them.
 */
function dampShift(r: RobotRuntime, index: number, kp: number, v: number): number {
  const j = r.joints[index];
  const scale = r.mem.dampScale as Float64Array | undefined;
  return (j.kd * (scale && j.state === 'ok' ? scale[index] : 1) * v) / kp;
}

/** Options of the balance engine's feed-forward (the legacy path passes none). */
export interface GroundForce {
  /** Horizontal ground force on the robot, N (split between the feet by their load share). */
  force: [number, number];
  /** Keep 10% of the available torque and ±0.35 rad of target shift as headroom (the servo keeps
   *  some spring and its implicit damping). */
  headroom: boolean;
}

const HEADROOM_TORQUE = 0.9;
const MAX_FF_SHIFT_RAD = 0.35;

/**
 * Adds the gravity / ground-reaction feed-forward to `targets` (radians) in place.
 * `gain` scales the whole term (1 = full compensation).
 */
export function applyGravityFeedforward(
  v: Views, r: RobotRuntime, joints: readonly JointInfo[], loads: Record<Side, FootLoad>,
  mass: number, targets: Float64Array, gain = 1, ground?: GroundForce, torqueOut?: Float64Array,
): void {
  const fzL = loads.l.share * mass * GRAVITY;
  const fzR = loads.r.share * mass * GRAVITY;
  for (const ji of joints) {
    const kp = effectiveKp(r, ji.index);
    if (kp <= 0) continue;
    let tau = v.qfrcBias[ji.dof];
    if (ji.leg) {
      const load = ji.leg === 'l' ? loads.l : loads.r;
      const fz = ji.leg === 'l' ? fzL : fzR;
      if (fz > 0) {
        const a = ji.jnt * 3;
        const dx = load.cop[0] - v.xanchor[a];
        const dy = load.cop[1] - v.xanchor[a + 1];
        // axis · ((p − anchor) × (0, 0, fz)) = fz · (axis_x·dy − axis_y·dx)
        tau -= fz * (v.xaxis[a] * dy - v.xaxis[a + 1] * dx);
        if (ground) {
          // The horizontal part of the planned ground force, at the COP on the canvas:
          // axis · (r × F) with r = (dx, dy, −anchor_z), F = (fx, fy, 0).
          const share = load.share;
          const fx = ground.force[0] * share, fy = ground.force[1] * share;
          const dz = -v.xanchor[a + 2];
          tau -= v.xaxis[a] * (-dz * fy) + v.xaxis[a + 1] * (dz * fx) + v.xaxis[a + 2] * (dx * fy - dy * fx);
        }
      }
    }
    const avail = r.joints[ji.index].availableTorque * (ground?.headroom ? HEADROOM_TORQUE : 1);
    const t = Math.max(-avail, Math.min(avail, tau * gain));
    const shift = t / kp;
    targets[ji.index] += ground?.headroom ? Math.max(-MAX_FF_SHIFT_RAD, Math.min(MAX_FF_SHIFT_RAD, shift)) : shift;
    if (torqueOut) torqueOut[ji.index] = t;
  }
}

const VEL_FILTER_S = 0.012;
const MAX_VEL_SHIFT_RAD = 0.35;

/**
 * Velocity feed-forward from a known target velocity (a mocap clip's exact q̇): the target is
 * shifted by (kd/kp)·q̇_des so the servo's damping acts on the tracking error, not on the motion.
 * `qd` is in r.joints order, rad/s.
 */
export function addVelocityFeedforward(r: RobotRuntime, targets: Float64Array, qd: ArrayLike<number>): void {
  for (let i = 0; i < targets.length; i++) {
    const kp = effectiveKp(r, i);
    if (kp <= 0) continue;
    const j = r.joints[i];
    const v = Math.max(-j.motor.noLoadSpeedRadS, Math.min(j.motor.noLoadSpeedRadS, qd[i]));
    targets[i] += Math.max(-MAX_VEL_SHIFT_RAD, Math.min(MAX_VEL_SHIFT_RAD, dampShift(r, i, kp, v)));
  }
}

/**
 * Velocity feed-forward. A position servo's damping acts on absolute joint speed, so it drags
 * against every commanded motion (kd·q̇ is ~270 N·m on a knee at 4 rad/s). Shifting the target
 * by (kd/kp)·q̇_des turns kv into damping on the tracking error instead. q̇_des is the filtered
 * rate of change of the posture targets, capped at the motor's no-load speed.
 *
 * Joints flagged in `hold` get no shift: their targets merely follow the measured body (a stance
 * hip yaw tracking a pelvis that is being spun), and adding the body's own motion to the target
 * would push the body further the same way.
 */
export class VelocityFeedforward {
  private prev: Float64Array | null = null;
  private readonly rate: Float64Array;
  readonly hold: Uint8Array;

  constructor(n: number) {
    this.rate = new Float64Array(n);
    this.hold = new Uint8Array(n);
  }

  reset(): void {
    this.prev = null;
    this.rate.fill(0);
  }

  /** The filtered rate of change of each target (rad/s, r.joints order), as of the last apply. */
  get rates(): Float64Array {
    return this.rate;
  }

  apply(r: RobotRuntime, targets: Float64Array, dt: number): void {
    if (!this.prev) {
      this.prev = Float64Array.from(targets);
      return;
    }
    const a = dt / (VEL_FILTER_S + dt);
    for (let i = 0; i < targets.length; i++) {
      const j = r.joints[i];
      const vmax = j.motor.noLoadSpeedRadS;
      const raw = Math.max(-vmax, Math.min(vmax, (targets[i] - this.prev[i]) / dt));
      this.rate[i] += (raw - this.rate[i]) * a;
      this.prev[i] = targets[i];
      const kp = effectiveKp(r, i);
      if (kp <= 0 || this.hold[i]) continue;
      const shift = dampShift(r, i, kp, this.rate[i]);
      targets[i] += Math.max(-MAX_VEL_SHIFT_RAD, Math.min(MAX_VEL_SHIFT_RAD, shift));
    }
  }
}

// ---------------------------------------------------------------- inverse dynamics (balance engine)

/**
 * Inverse-dynamics feed-forward (docs/design/balance-engine.md §3.6, Phase 2), tunable for A/B runs
 * (tools sweep it; the worker never changes it).
 */
export const INVERSE_DYNAMICS = {
  enabled: 1, // 0: the engine runs the Phase 1 feed-forward (gravity + the planned horizontal force)
  // 1 'full': the whole feed-forward from rne and the wrench the planned motion needs. Drills: the trunk's
  // fast wobble under the 0.10 rad/s gate on all four designs. Sparring (16 fights): self knockdowns 1.94
  // per fighter per 2 min against 0.52 without it, approach 0.17 against 0.35 m/s, landed 18.2 against
  // 26.1 per minute: the opponent's contact forces are not in the planned wrench, and the soles pressed
  // where a free body would need them.
  // 0 'reaction': the Phase 1 feed-forward, plus only what a leg in the air (a swing, a kick) adds: its own
  // inertial torque along its targets and its reaction on the trunk, carried by the stance leg (the soles
  // shift the COP by the L̇ it changes). Two feet down (most of a fight) it is the Phase 1 feed-forward.
  full: 0,
  // 0: ...also while a kick has a leg (the gait's shift and skill phases). The kicks' lift gate (DCM within
  // 2 cm of the stance sole's centre, P3) was tuned on the Phase 1 feed-forward; on this one the DCM settled
  // 2.7-3 cm off and the procedural front kicks never lifted. Strike drill, 72 kicks: 37 landed / 5 falls
  // with 1, 46 / 5 with 0 (P3: 43 / 7).
  kicks: 0,
  // 0: nor while any skill runs (a strike thrown from a step, a step-in): the reaction on top of a blow's own
  // loaded FIRECRACKER's 53 N·m stance hips past their limit (walk-in drill, 48 blows: 2 falls with it,
  // none without; 36 against 41 landed). Footwork keeps it.
  strikes: 0,
  accel: 1, // share of the targets' own acceleration fed through M(q) (swing legs, arms, waist)
  legAccel: 1, // ...of a leg in the air (a swing, a kick) (× accel)
  // ...and of a capture step's leg. A recovery's plan is not one the soles can carry (they are already
  // saturated); a catching leg driven to its fast plan tips the trunk with its reaction (HAYMAKER fell to
  // a 1.1 m/s shove with it on, stood with it off), so it swings on its servo's spring alone.
  captureLegAccel: 0,
  // Limit the legs' share to what the soles can carry (the required COP inside the support): 1 on, 0 off.
  // Measured off: walking swings ask for more than the soles hold and still track (and buzz) better driven.
  legLimit: 0,
  // Limit it to what the planted leg's servos can carry: no planted-leg joint is asked for more than
  // stanceShare of its available torque by a swing's reaction (1 on, 0 off).
  stanceLimit: 1,
  stanceShare: 0.85,
  kickLimit: 1, // ...for a kicking leg too (0: a kick is driven in full whatever the stance can hold)
  limitCut: 0.25, // reaction mode: a planted servo at its limit last tick cuts the air leg's share this much...
  limitRecover: 0.02, // ...which then grows back this much per tick
  waistGyro: 1, // the waist carries the gyro's couple (1) or leaves it to the servo spring (0)
  // What of the gyro's couple the soles are spared: 0 none, 1 all of it, 2 only the planned emergency
  // share, 3 as 2 but none while recovering (a catch step in the air, or the DCM outside the soles).
  //  1  the soles relax by everything the core adds, its trunk damping included: the damping is undone
  //     (stance shoves of 1.0-1.2 m/s survived 3-7 of 8 per design and level)
  //  0  the soles push on toward the plan's CMP past the gyro's share, the core's couple on top: the most
  //     correction there is (the best shove survival), but walking it over-delivers the plan (a slow
  //     sideways drift FIRECRACKER's walk could not step out of)
  //  2  the plan as planned: the soles carry it less the core's planned share; damping and bleed on top
  //  3  2 in footwork, 0 in a recovery
  gyroWrench: 3,
  accelTauS: 0.01, // the targets' acceleration is low-passed this much (it is a difference of rates)
  maxAccelRadS2: 300, // ...and clamped (a jump in the targets is a re-plan, not a motion to drive)
  base: 1, // share of the planned COM acceleration given to the pelvis
  // 1: the pelvis accelerates as the planned COP (and the gyro's planned share) pushes the measured
  // COM, ω²(c − COP − gyro share); 0: as the engine's COM reference does (its own model state).
  baseFromBody: 1,
  // 1: the soles carry the wrench the whole motion needs (its COP moves by the angular momentum the
  // limbs' accelerations change, Δ = L̇/(m·g), and by what the gyro does not deliver of its share),
  // clamped into the soles; 0: the planned COP, with the motion's force.
  wrench: 1,
  copShrinkM: 0.01, // the required COP stays this far inside the soles
  planSupport: 1, // 1: ...and inside the polygon the plan kept its COP in (the stance sole alone while a foot unloads)
  headroom: 0.9, // the feed-forward never asks for more than this share of the torque available...
  maxShiftRad: 0.35, // ...nor shifts a target further than this
};

/** What the inverse dynamics needs from the engine and the controller each tick. */
export interface InverseDynamicsInput {
  /** World horizontal acceleration wanted of the pelvis, m/s². */
  baseAcc: P2;
  /** Feet carrying ground force (planted). */
  planted: Record<Side, boolean>;
  /** The support (soles) the required COP is clamped into, world; fewer than 3 points: none. */
  support: readonly P2[];
  /** The planned COP (used as is when INVERSE_DYNAMICS.wrench is 0, or with no wrench to read). */
  plannedCop: P2;
  /** Splits the ground force between the feet for a COP (loads.ts footLoads). */
  loads: (cop: P2) => Record<Side, FootLoad>;
  /** The gyro core's couple on the torso this tick (world), or null. */
  gyro: Vec3 | null;
  /** The couple the plan asked of the gyro (its emergency share, world), or null. */
  gyroPlanned: Vec3 | null;
  /** Joints whose inertia the strike drive feeds forward itself (the burst chain), or null. */
  burst: ArrayLike<number> | null;
  /** A capture step is in the air (INVERSE_DYNAMICS.captureLegAccel applies to its leg). */
  capturing: boolean;
  /** Recovering: a capture step in the air, or the DCM outside the soles on two feet (gyroWrench 3). */
  recovering: boolean;
  /** A kick has the leg in the air (INVERSE_DYNAMICS.kickLimit). */
  kicking: boolean;
  /** A skill (a blow, a guard) is running (INVERSE_DYNAMICS.strikes). */
  striking: boolean;
  /** The filtered rates of the posture targets (VelocityFeedforward.rates), rad/s. */
  rates: Float64Array;
}

/** What one tick of the inverse dynamics found (the tools read it). */
export interface InverseDynamicsProbe {
  /** The COP the motion needs (before the clamp) and the one the soles are given. */
  copWant: P2;
  cop: P2;
  /** Ground force, N (world) and yaw moment the soles must grip, N·m. */
  force: Vec3;
  yawMoment: number;
  /** How far the required COP sits from the planned one (the angular-momentum feed-forward), m. */
  lddotShift: number;
  /** Share of the legs-in-the-air acceleration the soles could carry this tick (1: all of it). */
  legShare: number;
  /** Joints of planted legs whose feed-forward the headroom clamp cut this tick (the plan asked for more
   *  torque than the motor has to spare: a reserve metric). */
  clampedLegs: number;
  /** The largest share of its available torque the feed-forward asked of a planted-leg servo this tick. */
  legLoad: number;
}

type MjBuffer = { GetView(): Float64Array };

/**
 * Inverse-dynamics feed-forward for the balance engine: τ = rne(q, q̇, q̈_ref) − Σ Jᵀ·F_ground − Jᵀ·τ_gyro,
 * delivered as target shifts τ/kp_eff (the gain actually in force), clamped to the torque headroom.
 *   q̈_ref    the pelvis accelerates as the plan wants the COM to; swing legs, a kicking leg, the arms and
 *            the waist accelerate as their targets do (low-passed); planted legs follow the body
 *   F_ground  the force and moment the whole motion needs from the canvas: the free joint's rows of the
 *            same rne call, less the gyro's couple. Its COP is where the soles must press for the trunk
 *            not to rotate (a swinging leg's reaction is carried by the stance hip before it tips the
 *            pelvis); clamped into the soles, split between the planted feet by footLoads, each foot's
 *            share acting at its own COP, and the yaw moment gripped by the soles
 *   τ_gyro    the gyro's couple on the torso, carried by the waist; the soles are spared its planned
 *            emergency share in footwork and none of it in a recovery (gyroWrench)
 * A leg in the air (a swing, a kick) is driven along its targets only as hard as the planted leg's servos
 * can hold its reaction (stanceLimit): rne is linear in q̈, so one pass without and one with that leg's
 * acceleration give every share of it. A capture step's leg is not driven (captureLegAccel).
 * The striking chain keeps the gravity-only term (the strike drive feeds its inertia forward itself).
 * One or two mj_rne calls per robot per control tick (~2.6 µs each for the scene); qacc is restored.
 */
export class InverseDynamics {
  private readonly buf: MjBuffer;
  private view: Float64Array | null = null;
  /** The robot's dofs (free joint first, then its joints) and their saved qacc. */
  private readonly dofs: Int32Array;
  private readonly saved: Float64Array;
  /** rne rows of the robot (free joint, then r.joints order) without and with the legs in the air accelerating. */
  private readonly res0: Float64Array;
  private readonly res1: Float64Array;
  /** The ground wrench (force, moment about the pelvis origin; world) of each, and the one used. */
  private readonly w0 = new Float64Array(6);
  private readonly w1 = new Float64Array(6);
  private readonly w = new Float64Array(6);
  /** Planted legs' torques at no and at full legs-in-the-air acceleration (the stance limit). */
  private readonly t0: Float64Array;
  private readonly t1: Float64Array;
  private readonly prevRate: Float64Array;
  private readonly accel: Float64Array;
  private readonly chainMask: Uint8Array;
  private readonly waist: Uint8Array;
  private primed = false;
  /** The air leg's share as the planted servos' currents allow (limitCut). */
  private lamCap = 1;
  readonly probe: InverseDynamicsProbe = { copWant: [0, 0], cop: [0, 0], force: [0, 0, 0], yawMoment: 0, lddotShift: 0, legShare: 1, clampedLegs: 0, legLoad: 0 };

  constructor(mj: { DoubleBuffer: new (n: number) => MjBuffer }, nv: number, private readonly r: RobotRuntime) {
    this.buf = new mj.DoubleBuffer(nv);
    const n = r.joints.length;
    this.dofs = Int32Array.from([0, 1, 2, 3, 4, 5].map((k) => r.rootDadr + k).concat(r.joints.map((j) => j.dadr)));
    this.saved = new Float64Array(this.dofs.length);
    this.res0 = new Float64Array(this.dofs.length);
    this.res1 = new Float64Array(this.dofs.length);
    this.t0 = new Float64Array(n);
    this.t1 = new Float64Array(n);
    this.prevRate = new Float64Array(n);
    this.accel = new Float64Array(n);
    this.chainMask = new Uint8Array(n);
    this.waist = Uint8Array.from(r.joints, (j) => (j.part === 'torso' ? 1 : 0));
  }

  reset(): void {
    this.primed = false;
    this.lamCap = 1;
    this.accel.fill(0);
  }

  /** Adds the feed-forward to `targets` (radians, r.joints order) in place. */
  apply(ctx: { mj: { mj_rne(m: unknown, d: unknown, flg: number, out: MjBuffer): void }; model: unknown; data: { qacc: Float64Array; qfrc_bias: Float64Array; actuator_force: Float64Array } },
    v: Views, joints: readonly JointInfo[], inp: InverseDynamicsInput, targets: Float64Array, dt: number): void {
    const P = INVERSE_DYNAMICS;
    const r = this.r;
    const n = r.joints.length;
    // The targets' acceleration (from the velocity feed-forward's filtered rates).
    const rate = inp.rates;
    if (!this.primed) {
      this.prevRate.set(rate);
      this.primed = true;
    }
    const a = dt / (P.accelTauS + dt);
    for (let i = 0; i < n; i++) {
      const acc = (rate[i] - this.prevRate[i]) / dt;
      this.prevRate[i] = rate[i];
      this.accel[i] += (acc - this.accel[i]) * a;
    }
    this.chainMask.fill(0);
    if (inp.burst) for (let k = 0; k < inp.burst.length; k++) this.chainMask[inp.burst[k]] = 1;
    // q̈_ref into qacc (saved and restored: the step computes its own). Two passes: the body without
    // the legs in the air accelerating, then with them (rne is linear in q̈: their difference is what a
    // swinging or kicking leg's acceleration asks of the rest of the body).
    const qacc = ctx.data.qacc;
    const dofs = this.dofs;
    for (let k = 0; k < dofs.length; k++) this.saved[k] = qacc[dofs[k]];
    const b = r.rootDadr;
    qacc[b] = P.base * inp.baseAcc[0];
    qacc[b + 1] = P.base * inp.baseAcc[1];
    qacc[b + 2] = qacc[b + 3] = qacc[b + 4] = qacc[b + 5] = 0;
    let airLegs = false;
    for (const ji of joints) {
      const side = ji.leg;
      const acc = Math.max(-P.maxAccelRadS2, Math.min(P.maxAccelRadS2, this.accel[ji.index]));
      if (side === null) qacc[ji.dof] = P.accel * acc;
      else {
        qacc[ji.dof] = 0;
        if (!inp.planted[side] && acc !== 0) airLegs = true;
      }
    }
    const res0 = this.res0, res1 = this.res1;
    this.rne(ctx, res0);
    const legShare = P.accel * (inp.capturing ? P.captureLegAccel : P.legAccel);
    if (airLegs && legShare > 0) {
      for (const ji of joints) {
        const side = ji.leg;
        if (side !== null && !inp.planted[side]) qacc[ji.dof] = legShare * Math.max(-P.maxAccelRadS2, Math.min(P.maxAccelRadS2, this.accel[ji.index]));
      }
      this.rne(ctx, res1);
    } else res1.set(res0);
    for (let k = 0; k < dofs.length; k++) qacc[dofs[k]] = this.saved[k];
    // The wrench the canvas must supply: the free joint's rows (force in the world frame, torque about
    // the pelvis origin in its own frame), less the gyro's couple; at a share λ of the legs' acceleration.
    const ox = v.xpos[r.rootBody * 3], oy = v.xpos[r.rootBody * 3 + 1], oz = v.xpos[r.rootBody * 3 + 2];
    const R = r.rootBody * 9;
    const xm = v.xmat;
    const gw = P.gyroWrench === 1 ? inp.gyro : P.gyroWrench === 2 || (P.gyroWrench === 3 && !inp.recovering) ? inp.gyroPlanned : null;
    const w0 = this.w0, w1 = this.w1;
    for (let pass = 0; pass < 2; pass++) {
      const res = pass ? res1 : res0, w = pass ? w1 : w0;
      w[0] = res[0];
      w[1] = res[1];
      w[2] = res[2];
      w[3] = xm[R] * res[3] + xm[R + 1] * res[4] + xm[R + 2] * res[5] - (gw ? gw[0] : 0);
      w[4] = xm[R + 3] * res[3] + xm[R + 4] * res[4] + xm[R + 5] * res[5] - (gw ? gw[1] : 0);
      w[5] = xm[R + 6] * res[3] + xm[R + 7] * res[4] + xm[R + 8] * res[5] - (gw ? gw[2] : 0);
    }
    const pr = this.probe;
    const anyFoot = inp.planted.l || inp.planted.r;
    const support = inp.support as P2[];
    const poly = support.length >= 3;
    const W = this.w;
    const want: P2 = [0, 0];
    // The ground side at a share k of the legs' acceleration: the wrench, its COP (clamped into the soles),
    // the yaw moment the soles grip and the split between the feet.
    const ground = (k: number): { loads: Record<Side, FootLoad> | null; nz: number; p: P2 } => {
      for (let q = 0; q < 6; q++) W[q] = w0[q] + k * (w1[q] - w0[q]);
      if (!anyFoot || W[2] <= 1) return { loads: null, nz: 0, p: want };
      // The COP of that wrench on the canvas (z = 0): (p − o) × F + n·ẑ = M.
      want[0] = ox + (-oz * W[0] - W[4]) / W[2];
      want[1] = oy + (W[3] - oz * W[1]) / W[2];
      let p: P2 = P.wrench ? [want[0], want[1]] : [inp.plannedCop[0], inp.plannedCop[1]];
      if (poly) p = clampToPolygon(support, p);
      const nz = W[5] - ((p[0] - ox) * W[1] - (p[1] - oy) * W[0]);
      return { loads: inp.loads(p), nz, p };
    };
    const qb = ctx.data.qfrc_bias;
    const g = inp.gyro;
    // One joint's feed-forward torque at share k of the legs' acceleration, with the ground side `gr`.
    const torque = (ji: JointInfo, k: number, gr: { loads: Record<Side, FootLoad> | null; nz: number }): number => {
      const i = ji.index;
      const kk = 6 + i;
      let tau = this.chainMask[i] ? qb[ji.dof] : res0[kk] + k * (res1[kk] - res0[kk]);
      const side = ji.leg;
      const k3 = ji.jnt * 3;
      if (side && gr.loads && inp.planted[side]) {
        const load = gr.loads[side];
        const sh = load.share;
        if (sh > 0) {
          // axis · ((p − anchor) × F + n·ẑ), F and n this foot's share.
          const px = load.cop[0] - v.xanchor[k3], py = load.cop[1] - v.xanchor[k3 + 1], pz = -v.xanchor[k3 + 2];
          const Fx = W[0] * sh, Fy = W[1] * sh, Fz = W[2] * sh;
          const tx = py * Fz - pz * Fy, ty = pz * Fx - px * Fz, tz = px * Fy - py * Fx + gr.nz * sh;
          tau -= v.xaxis[k3] * tx + v.xaxis[k3 + 1] * ty + v.xaxis[k3 + 2] * tz;
        }
      }
      if (g && P.waistGyro && this.waist[i] && !this.chainMask[i]) tau -= v.xaxis[k3] * g[0] + v.xaxis[k3 + 1] * g[1] + v.xaxis[k3 + 2] * g[2];
      return tau;
    };
    let lam = 1;
    let gr = ground(1);
    if (anyFoot && airLegs && legShare > 0 && gr.loads) {
      // A swing (or a kick) the stance leg cannot hold up against: its acceleration is fed forward only as far
      // as the planted leg's servos have torque to carry its reaction (legLimit: and the soles the COP), so the
      // swing leg yields to the stance instead of the trunk tipping (FIRECRACKER's 53 N·m hips held the trunk
      // through 4-6% of single support at their limit with the swing driven in full).
      const t1 = this.t1, t0 = this.t0;
      let over = false;
      for (const ji of joints) {
        if (!ji.leg || !inp.planted[ji.leg]) continue;
        t1[ji.index] = torque(ji, 1, gr);
        if (Math.abs(t1[ji.index]) > P.stanceShare * r.joints[ji.index].availableTorque) over = true;
      }
      let copOut = false;
      if (P.wrench && P.legLimit && poly && polygonDistance(support, want).d > 0) copOut = true;
      if ((P.stanceLimit && over) || copOut) {
        const g0 = ground(0);
        for (const ji of joints) if (ji.leg && inp.planted[ji.leg]) t0[ji.index] = torque(ji, 0, g0);
        if (P.stanceLimit && over && (P.kickLimit || !inp.kicking)) {
          for (const ji of joints) {
            if (!ji.leg || !inp.planted[ji.leg]) continue;
            const lim = P.stanceShare * r.joints[ji.index].availableTorque;
            const a = t0[ji.index], b = t1[ji.index];
            if (Math.abs(b) <= lim || Math.abs(a) >= lim) continue;
            // |a + λ(b − a)| = lim, the root between 0 and 1
            const target = b > a ? lim : -lim;
            lam = Math.min(lam, Math.max(0, (target - a) / (b - a)));
          }
        }
        if (copOut) {
          const cop: P2 = [0, 0];
          ground(0);
          const in0 = polygonDistance(support, [want[0], want[1]]).d <= 0;
          if (!in0) lam = 0;
          else {
            let lo = 0, hi = lam;
            for (let it = 0; it < 7; it++) {
              const mid = (lo + hi) / 2;
              ground(mid);
              cop[0] = want[0];
              cop[1] = want[1];
              if (polygonDistance(support, cop).d <= 0) lo = mid;
              else hi = mid;
            }
            lam = lo;
          }
        }
        gr = ground(lam);
      }
    }
    if (gr.loads) {
      pr.copWant[0] = want[0];
      pr.copWant[1] = want[1];
      pr.cop[0] = gr.p[0];
      pr.cop[1] = gr.p[1];
      pr.lddotShift = Math.hypot(want[0] - inp.plannedCop[0], want[1] - inp.plannedCop[1]);
      pr.yawMoment = gr.nz;
    }
    pr.force[0] = W[0];
    pr.force[1] = W[1];
    pr.force[2] = W[2];
    pr.legShare = lam;
    let clamped = 0;
    let legLoad = 0;
    for (const ji of joints) {
      const i = ji.index;
      const kp = effectiveKp(r, i);
      if (kp <= 0) continue;
      const tau = torque(ji, lam, gr);
      const side = ji.leg;
      if (side && inp.planted[side]) legLoad = Math.max(legLoad, Math.abs(tau) / Math.max(1e-6, r.joints[i].availableTorque));
      const avail = r.joints[i].availableTorque * P.headroom;
      const t = Math.max(-avail, Math.min(avail, tau));
      const shift = t / kp;
      if (side && inp.planted[side] && (t !== tau || Math.abs(shift) > P.maxShiftRad)) clamped++;
      targets[i] += Math.max(-P.maxShiftRad, Math.min(P.maxShiftRad, shift));
    }
    pr.clampedLegs = clamped;
    pr.legLoad = legLoad;
  }

  /**
   * INVERSE_DYNAMICS.full = 0: on top of the Phase 1 feed-forward already in `targets` (its torque per joint
   * in `tauOld`), only what a leg in the air adds: its inertial torque along its targets (M·q̈ from the
   * difference of two rne passes) and the reaction of that acceleration on the rest of the body (the base
   * rows of the same difference: a wrench the canvas must add), carried by the planted leg at the planned
   * COP, split by load share. Scaled down as far as the planted leg's servos need (stanceLimit). A capture
   * step's leg adds nothing (captureLegAccel). Two feet down nothing changes.
   */
  applyReaction(ctx: { mj: { mj_rne(m: unknown, d: unknown, flg: number, out: MjBuffer): void }; model: unknown; data: { qacc: Float64Array; qfrc_bias: Float64Array; actuator_force: Float64Array } },
    v: Views, joints: readonly JointInfo[], inp: InverseDynamicsInput, targets: Float64Array, dt: number, tauOld: Float64Array): void {
    const P = INVERSE_DYNAMICS;
    const r = this.r;
    const n = r.joints.length;
    const rate = inp.rates;
    if (!this.primed) {
      this.prevRate.set(rate);
      this.primed = true;
    }
    const a = dt / (P.accelTauS + dt);
    for (let i = 0; i < n; i++) {
      const acc = (rate[i] - this.prevRate[i]) / dt;
      this.prevRate[i] = rate[i];
      this.accel[i] += (acc - this.accel[i]) * a;
    }
    const pr = this.probe;
    pr.legShare = 0;
    pr.clampedLegs = 0;
    const legShare = P.accel * (inp.capturing ? P.captureLegAccel : P.legAccel) * (inp.kicking && !P.kicks ? 0 : 1) * (inp.striking && !P.strikes ? 0 : 1);
    let airLegs = false;
    for (const ji of joints) if (ji.leg !== null && !inp.planted[ji.leg] && this.accel[ji.index] !== 0) airLegs = true;
    if (!airLegs || legShare <= 0 || !(inp.planted.l || inp.planted.r)) {
      pr.legLoad = 0;
      return;
    }
    // Two passes, the same state, with and without the air leg's acceleration: their difference is M·q̈_leg.
    const qacc = ctx.data.qacc;
    const dofs = this.dofs;
    for (let k = 0; k < dofs.length; k++) this.saved[k] = qacc[dofs[k]];
    for (let k = 0; k < dofs.length; k++) qacc[dofs[k]] = 0;
    this.rne(ctx, this.res0);
    for (const ji of joints) {
      if (ji.leg !== null && !inp.planted[ji.leg]) qacc[ji.dof] = legShare * Math.max(-P.maxAccelRadS2, Math.min(P.maxAccelRadS2, this.accel[ji.index]));
    }
    this.rne(ctx, this.res1);
    for (let k = 0; k < dofs.length; k++) qacc[dofs[k]] = this.saved[k];
    const res0 = this.res0, res1 = this.res1;
    // The reaction wrench the canvas must add (rows 0-5, the free joint: force, world; moment about the
    // pelvis origin, in its frame → world).
    const R = r.rootBody * 9;
    const xm = v.xmat;
    const dF0 = res1[0] - res0[0], dF1 = res1[1] - res0[1], dF2 = res1[2] - res0[2];
    const l3 = res1[3] - res0[3], l4 = res1[4] - res0[4], l5 = res1[5] - res0[5];
    const dM0 = xm[R] * l3 + xm[R + 1] * l4 + xm[R + 2] * l5;
    const dM1 = xm[R + 3] * l3 + xm[R + 4] * l4 + xm[R + 5] * l5;
    const dM2 = xm[R + 6] * l3 + xm[R + 7] * l4 + xm[R + 8] * l5;
    const ox = v.xpos[r.rootBody * 3], oy = v.xpos[r.rootBody * 3 + 1], oz = v.xpos[r.rootBody * 3 + 2];
    const loads = inp.loads(inp.plannedCop);
    // Each planted joint's share of it: −axis·((p − a) × ΔF + ΔM_p), with ΔM_p = ΔM − (p − o) × ΔF at
    // its foot's COP p (the sole shifts its pressure by the horizontal part, its grip takes the yaw).
    const delta = this.t1;
    for (const ji of joints) {
      const i = ji.index;
      delta[i] = 0;
      const side = ji.leg;
      if (side === null) continue;
      if (!inp.planted[side]) {
        delta[i] = res1[6 + i] - res0[6 + i];
        continue;
      }
      const load = loads[side];
      const sh = load.share;
      if (sh <= 0) continue;
      const px = load.cop[0], py = load.cop[1], pz = 0;
      const rx = px - ox, ry = py - oy, rz = pz - oz;
      const mpx = dM0 - (ry * dF2 - rz * dF1), mpy = dM1 - (rz * dF0 - rx * dF2), mpz = dM2 - (rx * dF1 - ry * dF0);
      const k3 = ji.jnt * 3;
      const ax = px - v.xanchor[k3], ay = py - v.xanchor[k3 + 1], az = pz - v.xanchor[k3 + 2];
      const tx = ay * dF2 - az * dF1 + mpx, ty = az * dF0 - ax * dF2 + mpy, tz = ax * dF1 - ay * dF0 + mpz;
      delta[i] = -sh * (v.xaxis[k3] * tx + v.xaxis[k3 + 1] * ty + v.xaxis[k3 + 2] * tz);
    }
    // As much of it as the planted leg's servos can carry on top of what they already do.
    let lam = 1;
    if (P.stanceLimit && (P.kickLimit || !inp.kicking)) {
      for (const ji of joints) {
        if (!ji.leg || !inp.planted[ji.leg]) continue;
        const lim = P.stanceShare * r.joints[ji.index].availableTorque;
        const t0 = tauOld[ji.index], t1 = t0 + delta[ji.index];
        if (Math.abs(t1) <= lim || Math.abs(t0) >= lim) continue;
        const target = t1 > t0 ? lim : -lim;
        lam = Math.min(lam, Math.max(0, (target - t0) / (t1 - t0)));
      }
    }
    // ...and as the servos' own currents say: a planted-leg servo at its limit last tick (its spring adds
    // to the feed-forward) cuts the share at once, which then recovers slowly.
    if (P.limitCut > 0) {
      const force = ctx.data.actuator_force;
      let hit = false;
      for (const ji of joints) {
        if (!ji.leg || !inp.planted[ji.leg]) continue;
        const j = r.joints[ji.index];
        if (Math.abs(force[j.act]) >= 0.97 * j.availableTorque) { hit = true; break; }
      }
      this.lamCap = hit ? Math.max(0, this.lamCap - P.limitCut) : Math.min(1, this.lamCap + P.limitRecover);
      lam = Math.min(lam, this.lamCap);
    }
    pr.legShare = lam;
    let load = 0;
    for (const ji of joints) {
      const i = ji.index;
      if (ji.leg === null || delta[i] === 0) continue;
      const kp = effectiveKp(r, i);
      if (kp <= 0) continue;
      const avail = r.joints[i].availableTorque * P.headroom;
      const before = tauOld[i];
      const after = Math.max(-avail, Math.min(avail, before + lam * delta[i]));
      if (inp.planted[ji.leg]) load = Math.max(load, Math.abs(after) / Math.max(1e-6, r.joints[i].availableTorque));
      const s0 = Math.max(-P.maxShiftRad, Math.min(P.maxShiftRad, before / kp));
      const s1 = Math.max(-P.maxShiftRad, Math.min(P.maxShiftRad, after / kp));
      targets[i] += s1 - s0;
    }
    pr.legLoad = load;
  }

  /** One mj_rne call; the robot's own rows (free joint, then its joints) into `out`. */
  private rne(ctx: { mj: { mj_rne(m: unknown, d: unknown, flg: number, out: MjBuffer): void }; model: unknown; data: unknown }, out: Float64Array): void {
    ctx.mj.mj_rne(ctx.model, ctx.data, 1, this.buf);
    let res = this.view;
    if (!res || res.length === 0) res = this.view = this.buf.GetView();
    const dofs = this.dofs;
    for (let k = 0; k < dofs.length; k++) out[k] = res[dofs[k]];
  }
}
