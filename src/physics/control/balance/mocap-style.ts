// Mocap footwork's style layer (docs/design/balance-engine.md §2: "Mocap is intent and style;
// balance is feasibility"; §9 Phase 5). While the feet are free, the clip the feet are taking (its
// clock synced to the real contacts by MocapSteps) or, holding, the guard idle colours the stance:
// the arms blend the clip's guard into ours, the shoulders roll with its waist turn, the pelvis bobs
// (at most MOCAP_STYLE.bobMaxM), tilts and sways with it. All of it is bounded, low-passed offsets on
// the stance: balance keeps the legs and the pelvis position (the joint table in §2).
//   comComp   optional (off): the engine balances the body without the style's own COM shift, as in
//             Lee, Kim and Lee (2010): corrections remove error, not style. Measured here it made the
//             approach drills hunt more (the shift's rate is noisy at clip switches), so it stays off
// OFF by default (SD_MOCAP_FOOTWORK = 1 or style turns it on). Measured in 72 sparring fights per
// config against clip steps alone: these values cost 3.0 strikes thrown and 2.2 landed per minute
// (−16%, the trunk's tilt trips the strike gate's torso-rate check) and nearly doubled the guards'
// contact; the waist turn and sway alone (arms, bob, tilt and bend 0) added 0.3 stepping falls per
// fighter per 2 min (P 0.95). Allocation free per tick (comComp aside).
import type { Vec3 } from '../../../core/types';
import { newSample, sample, type MotionSample } from '../../../robots/motions';
import { SIDES, type HumanoidGeometry, type Side } from '../geometry';
import { armFK, armIK, newArmAngles, type ArmAngles } from '../ik';
import { clamp, mulMV, rot2, wrapAngle, type Mat3 } from '../math';
import type { DbClip } from '../mocap/footwork-db';
import type { MocapSet } from '../mocap/library';
import type { BodyCommand, JointMap } from '../posture';
import type { SkillPose } from '../skills/types';
import type { StanceParams } from '../stance';
import type { P2 } from '../support';

const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SD_MOCAP_FOOTWORK;

/** Style tuning (offsets on the stance; 0..1 weights). Exported so tools can sweep it. */
export const MOCAP_STYLE = {
  /** 1: on (SD_MOCAP_FOOTWORK=1 or =style); off by default, see the header. */
  enabled: ENV === '1' || ENV === 'style' ? 1 : 0,
  // Measured on the full approach-and-hold drills (40 per design): with 0.35 of the arms, a 0.8 cm
  // bob and comComp, PYLON fell once and hunted up to 16 steps after arriving; at these values the
  // drills match the planner-only footwork (no falls, the same DCM error).
  arms: 0.1, // share of the clip's arms in the guard (more moves the COM enough to unsettle a held stance:
  //           §4.3 has the guard's fists fixed in the torso frame)
  waist: 0.5, // share of the clip's waist turn (the shoulders roll with the steps)...
  waistBend: 0.15, // ...and of its bend (a torso pitching with the actor's reads as wobble, not style)
  waistMaxRad: 0.15,
  bobGain: 0.3, // pelvis drop per metre of the clip's own (a boxer's bounce is 8-14 cm)...
  bobMaxM: 0.005, // ...scaled down so its 95th percentile is at most this (§4.3 caps the clip bob at 1.5 cm; a
  //              vertical bounce changes ω₀² by c̈_z/g, and a clamped one would be a square wave)
  bobTauS: 0.04, // the bob is low-passed (no step the servos would chase)...
  trunkTauS: 0.08, // ...and the trunk's tilt and bend more (under ~2 Hz)
  tilt: 0.15, // share of the clip's pelvis pitch and roll
  tiltMaxRad: 0.05,
  sway: 0.4, // share of the clip's pelvis yaw swing about its blade
  swayMaxRad: 0.1,
  comComp: 0, // 1: the engine balances the body without the style's COM shift (see the header)
  fadeS: 0.2, // the style fades in and out over this long
  idleWeight: 1, // the guard idle's share of the style while holding (1: as much as stepping)
  idleRate: 1.0, // the guard idle plays at this time scale (× aggression's 0.85-1.15)
};

/** Segment masses for the COM shift (kg): the whole body, the upper body's lever, the arms. */
export interface StyleMasses {
  total: number;
  /** Upper-body share of the mass × its height above the pelvis (m). */
  upperLever: number;
  arm: Record<Side, { upper: number; lower: number }>;
}

export class MocapStyle {
  /** Style weight (fades in and out). */
  w = 0;
  /**
   * Where the style layer has put the COM (comComp only): its arm and trunk offsets' share of the
   * whole-body COM (world, horizontal, m) and its rate.
   */
  readonly comShift: P2 = [0, 0];
  readonly comShiftVel: P2 = [0, 0];
  private bob = 0;
  private tiltP = 0;
  private tiltR = 0;
  private swayY = 0;
  private waistY = 0;
  private waistP = 0;
  private idleTau = 0;
  private readonly guardCom: Record<Side, Vec3>;
  private readonly sample: MotionSample;
  private readonly q: Float64Array; // r.joints order
  private readonly guard: Record<Side, ArmAngles>;
  private readonly ypr: Vec3 = [0, 0, 0];

  constructor(
    private readonly set: MocapSet,
    private readonly geo: HumanoidGeometry,
    stance: StanceParams,
    private readonly jm: JointMap,
    joints: number,
    /** The guard idle (the style while holding), or null. */
    private readonly idle: DbClip | null,
    private readonly mass: StyleMasses,
  ) {
    this.sample = newSample(set.lib.joints.length);
    this.q = new Float64Array(joints);
    this.guard = { l: newArmAngles(), r: newArmAngles() };
    for (const side of SIDES) armIK(geo.arms[side], stance.guard[side].fist, stance.guard[side].pole, this.guard[side]);
    this.guardCom = { l: this.armMoment('l', this.guard.l), r: this.armMoment('r', this.guard.r) };
  }

  /**
   * Writes the style (call with no skill running, after the engine's tick): arms, waist and pelvis
   * offsets from `clip` at clip time `tau` (the feet's clip, contact-synced), or the guard idle when
   * there is none. `on`: the feet are free (no skill, no victory), else the style is off at once.
   */
  apply(pose: SkillPose, cmd: BodyCommand, dt: number, on: boolean, clip: DbClip | null, tau: number, aggression: number, torsoRot: Mat3, heading: number): void {
    const M = MOCAP_STYLE;
    if (!on || !M.enabled) {
      // Something else owns the body (a skill, the victory): off at once, back in with a fade.
      this.w = 0;
      this.bob = this.tiltP = this.tiltR = this.swayY = this.waistY = this.waistP = 0;
      this.comShift[0] = this.comShift[1] = this.comShiftVel[0] = this.comShiftVel[1] = 0;
      return;
    }
    this.idleTau += dt * M.idleRate * (0.85 + 0.3 * clamp(aggression, 0, 1));
    // Holding (the guard idle) the style is idleWeight of a step's; the change fades over fadeS.
    const want = clip ? 1 : M.idleWeight;
    this.w += clamp(want - this.w, -dt / M.fadeS, dt / M.fadeS);
    const w = this.w;
    const c = clip ?? this.idle;
    if (!c) return;
    sample(c.move, clip ? tau : this.idleTau, { speed: 1, loop: c.move.loop }, this.sample);
    const map = this.set.toRobot;
    for (let j = 0; j < map.length; j++) if (map[j] >= 0) this.q[map[j]] = this.sample.q[j];
    this.arms(cmd, M.arms * w);
    const kt = Math.min(1, dt / M.trunkTauS);
    this.waistY += (clamp((this.q[this.jm.waistYaw] - c.waist[0]) * M.waist, -M.waistMaxRad, M.waistMaxRad) - this.waistY) * kt;
    this.waistP += (clamp((this.q[this.jm.waistPitch] - c.waist[1]) * M.waistBend, -M.waistMaxRad, M.waistMaxRad) - this.waistP) * kt;
    pose.waistYaw += this.waistY * w;
    pose.waistPitch += this.waistP * w;
    const a = yawPitchRoll(this.sample.rootQuat, this.ypr);
    const yaw = a[0], pitch = a[1], roll = a[2];
    // The pelvis offsets are low-passed: a clip switch or a clock jump must not step the leg targets.
    const k = Math.min(1, dt / M.bobTauS);
    const bobK = Math.min(M.bobGain, M.bobMaxM / Math.max(1e-3, c.bobAmp));
    this.bob += (clamp((c.standZ - this.sample.rootPos[2]) * bobK, -1.5 * M.bobMaxM, 1.5 * M.bobMaxM) - this.bob) * k;
    this.tiltP += (clamp((pitch - c.tilt[0]) * M.tilt, -M.tiltMaxRad, M.tiltMaxRad) - this.tiltP) * kt;
    this.tiltR += (clamp((roll - c.tilt[1]) * M.tilt, -M.tiltMaxRad, M.tiltMaxRad) - this.tiltR) * kt;
    this.swayY += (clamp(wrapAngle(yaw - c.blade) * M.sway, -M.swayMaxRad, M.swayMaxRad) - this.swayY) * k;
    pose.pelvisDrop += this.bob * w;
    pose.pelvisPitch += this.tiltP * w;
    pose.pelvisRoll += this.tiltR * w;
    pose.pelvisYaw += this.swayY * w;
    if (M.comComp) this.shiftCom(cmd, dt, w, torsoRot, heading);
  }

  /** The arms: the clip's (sampled into q) blended into the guard by k, in joint space. */
  private arms(cmd: BodyCommand, k: number): void {
    for (const side of SIDES) {
      const m = this.jm.arm[side];
      const g = this.guard[side];
      const arm = cmd.arms[side];
      arm.mode = 'joints';
      arm.angles.pitch = g.pitch + (this.q[m.pitch] - g.pitch) * k;
      arm.angles.roll = g.roll + (this.q[m.roll] - g.roll) * k;
      arm.angles.yaw = g.yaw + (this.q[m.yaw] - g.yaw) * k;
      arm.angles.elbow = g.elbow + (this.q[m.elbow] - g.elbow) * k;
    }
  }

  /** Σ m·p of an arm's two segments (torso frame): the upper arm at its middle, the forearm and fist
   *  60% of the way to the fist (the fist's mass is at the end). */
  private armMoment(side: Side, a: ArmAngles): Vec3 {
    const g = this.geo.arms[side];
    const m = this.mass.arm[side];
    const fk = armFK(g, a);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) out[i] = m.upper * 0.5 * (g.shoulder[i] + fk.elbow[i]) + m.lower * (fk.elbow[i] + 0.6 * (fk.fist[i] - fk.elbow[i]));
    return out;
  }

  /**
   * The style's COM shift (comShift): the arms it commands against the guard (their segments' moment,
   * turned into the world by the measured torso) and the trunk's pitch and roll offsets (the upper
   * body's lever), over the whole mass; its rate by a low-passed difference.
   */
  private shiftCom(cmd: BodyCommand, dt: number, w: number, torsoRot: Mat3, heading: number): void {
    const ms = this.mass;
    if (ms.total <= 0) return;
    let tx = 0, ty = 0, tz = 0;
    for (const side of SIDES) {
      const p = this.armMoment(side, cmd.arms[side].angles);
      const g = this.guardCom[side];
      tx += p[0] - g[0];
      ty += p[1] - g[1];
      tz += p[2] - g[2];
    }
    const wv = mulMV(torsoRot, [tx, ty, tz]);
    // The trunk: pitch leans the upper body forward, roll to the right (Rz·Ry·Rx).
    const pitch = (this.tiltP + this.waistP) * w, roll = this.tiltR * w;
    const [fx, fy] = rot2(ms.upperLever * pitch, -ms.upperLever * roll, heading);
    const x = wv[0] / ms.total + fx, y = wv[1] / ms.total + fy;
    const k = Math.min(1, dt / 0.02);
    const vx = (x - this.comShift[0]) / Math.max(dt, 1e-4), vy = (y - this.comShift[1]) / Math.max(dt, 1e-4);
    this.comShiftVel[0] += (vx - this.comShiftVel[0]) * k;
    this.comShiftVel[1] += (vy - this.comShiftVel[1]) * k;
    this.comShift[0] = x;
    this.comShift[1] = y;
  }
}

/** Yaw, pitch, roll (Z·Y·X) of a quaternion [w, x, y, z], into `out`. */
function yawPitchRoll(q: readonly number[], out: Vec3): Vec3 {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const r0 = 1 - 2 * (y * y + z * z), r3 = 2 * (x * y + w * z), r6 = 2 * (x * z - w * y);
  const r7 = 2 * (y * z + w * x), r8 = 1 - 2 * (x * x + y * y);
  out[0] = Math.atan2(r3, r0);
  out[1] = Math.asin(clamp(-r6, -1, 1));
  out[2] = Math.atan2(r7, r8);
  return out;
}
