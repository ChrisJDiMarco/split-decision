// The upper-body arbiter (docs/design/balance-engine.md §2 and §6, Euphoria's limb arbitration): what the
// arms, the waist and the posture do while the reactions (reactions.ts) say absorb, recover, brace or
// pre-brace. Legs and the pelvis's place stay the engine's (balance has strict priority there: a blended
// foot lands in neither place); arms and waist blend by weight, highest first:
//   brace     both hands to where the body will land, elbows bent 30°; the waist tucks in a backward
//             fall or turns onto the hip and shoulder; the knees fold (the pelvis sinks); arms stiff
//             (1.0), legs soft (braceLegKp). Overrides a blow (the reactions end it)
//   strike    a blow owns its arm (the skill's command, untouched here)
//   arms out  recovering: shoulder abduction with the torso's tumble rate, the fall side first, added to
//             whatever the arms were doing
//   guard     the rest (the stance guard, the mocap style's arms)
// Posture: recovering, the pelvis 3 cm lower; pre-braced, 2 cm lower with the guard and waist stiffer.
// Stiffness: the absorbing chain (the part a hit landed on) at the reaction's absorbScale.
// Every one of these is a target or a gain an MIT-mode drive takes each frame: no force is added.
import type { Vec3 } from '../../../core/types';
import type { RobotRuntime } from '../../sim-context';
import type { Gait } from '../gait';
import { SIDES, sideSign, type HumanoidGeometry, type Side } from '../geometry';
import { clamp, mix, mulMtV, sub } from '../math';
import type { BodyCommand, JointMap } from '../posture';
import type { Sense } from '../sense';
import type { SkillPose } from '../skills/types';
import { REACTIONS, type Reactions } from './reactions';

/** Tunables (exported so tools can sweep them; the worker never changes them). */
export const BEHAVIOURS = {
  braceInS: 0.03, // the brace takes the arms this fast (Euphoria: within a tick; the motors set the pace)
  braceOutS: 0.2,
  braceElbow: 0.52, // rad of elbow bend in the catch (30°)
  braceHandOut: 0.6, // the hands land this far either side of the fall line, × shoulder half-width
  braceDrop: 0.3, // the knees fold: the pelvis this far lower, × leg length
  braceDropS: 0.12,
  braceTuck: 0.55, // waist pitch forward in a backward fall, rad
  braceTurn: 0.4, // waist yaw onto the hip and shoulder in a forward or sideways fall, rad
  braceLegKp: 0.4, // legs soft (kv scales with its square root: 0.63)
  braceArmKp: 1,
  dropDownS: 0.06, // a posture drop goes in this fast...
  dropUpS: 0.3, // ...and comes back this slowly
};

/**
 * Per-design brace: the knee fold (× braceDrop), the hands and waist, and whether the catch is held through the
 * landing (getup.ts catchPose). The iron age gets up by the scripted sequence, tuned on bodies that land flat
 * ("fall stiff, like a plank"): landed kneeling, or with its arms out (the brace's, or flung out recovering), GOLIATH
 * and BRUISER never got up (tests/control/getup.test.ts). So it braces with its feet and gyro only, keeps its arms in
 * the guard while recovering, and falls the plank it was tuned for.
 */
export const BRACE_DESIGN: Record<string, { drop: number; hold: boolean; arms: boolean }> = {
  bruiser: { drop: 0, hold: false, arms: false }, striker: { drop: 0, hold: false, arms: false }, goliath: { drop: 0, hold: false, arms: false },
};

export class Behaviours {
  /** Brace weight (0..1), eased. */
  braceW = 0;
  private drop = 0;
  private readonly arm: Record<Side, Int16Array>;
  private readonly leg: Record<Side, Int16Array>;
  private readonly waist: Int16Array;
  private readonly roll: Record<Side, number>;

  /** This design's knee fold in a brace (× BEHAVIOURS.braceDrop), and whether it holds its catch on the canvas. */
  private readonly foldShare: number;
  readonly holdsCatch: boolean;
  private readonly braceArms: boolean;

  constructor(private readonly geo: HumanoidGeometry, jm: JointMap, private readonly r: RobotRuntime) {
    this.foldShare = BRACE_DESIGN[r.design.id]?.drop ?? 1;
    this.holdsCatch = BRACE_DESIGN[r.design.id]?.hold ?? true;
    this.braceArms = BRACE_DESIGN[r.design.id]?.arms ?? true;
    const a = (s: Side) => Int16Array.from([jm.arm[s].pitch, jm.arm[s].roll, jm.arm[s].yaw, jm.arm[s].elbow]);
    const l = (s: Side) => Int16Array.from([jm.leg[s].hipYaw, jm.leg[s].hipRoll, jm.leg[s].hipPitch, jm.leg[s].knee, jm.leg[s].anklePitch, jm.leg[s].ankleRoll]);
    this.arm = { l: a('l'), r: a('r') };
    this.leg = { l: l('l'), r: l('r') };
    this.waist = Int16Array.from([jm.waistYaw, jm.waistPitch]);
    this.roll = { l: jm.arm.l.roll, r: jm.arm.r.roll };
  }

  reset(): void {
    this.braceW = 0;
    this.drop = 0;
  }

  /**
   * Before the IK: the posture and the arm and waist commands for the reaction under way. `pose` and
   * `cmd` hold what the skill, the style layer or the guard asked for; this blends the reaction in.
   */
  pose(react: Reactions, s: Sense, pose: SkillPose, cmd: BodyCommand, dt: number): void {
    const B = BEHAVIOURS;
    if (!REACTIONS.enabled) return;
    const bracing = react.mode === 'brace';
    const k = Math.min(1, dt / (bracing ? B.braceInS : B.braceOutS));
    this.braceW += ((bracing ? 1 : 0) - this.braceW) * k;
    const wantDrop = bracing ? B.braceDrop * this.foldShare * this.geo.legLength : react.mode === 'recover' ? REACTIONS.recoverDropM : react.preBrace ? REACTIONS.preDropM : 0;
    const tau = bracing ? B.braceDropS : wantDrop > this.drop ? B.dropDownS : B.dropUpS;
    this.drop += (wantDrop - this.drop) * Math.min(1, dt / tau);
    pose.pelvisDrop += this.drop;
    const w = this.braceW;
    if (w < 1e-3 || !this.braceArms) return;
    // Hands to where the body will land: from each shoulder toward the contact point (either side of the
    // fall line), as far as the arm reaches with the elbow bent 30°.
    const f = react.fall;
    const lx = -f.dir[1], ly = f.dir[0];
    for (const side of SIDES) {
      const a = this.geo.arms[side];
      const off = B.braceHandOut * Math.abs(a.shoulder[1]) * sideSign(side);
      const world: Vec3 = [f.contact[0] + lx * off, f.contact[1] + ly * off, a.fistHalf];
      const local = mulMtV(s.torsoRot, sub(world, s.torsoPos));
      const d = sub(local, a.shoulder);
      const n = Math.hypot(d[0], d[1], d[2]) || 1;
      const bent = Math.sqrt(a.upper * a.upper + a.fore * a.fore + 2 * a.upper * a.fore * Math.cos(B.braceElbow));
      const reach = Math.min(n, bent);
      const fist: Vec3 = [a.shoulder[0] + (d[0] / n) * reach, a.shoulder[1] + (d[1] / n) * reach, a.shoulder[2] + (d[2] / n) * reach];
      // Elbows back and out (they fold as the hands take the weight).
      const pole: Vec3 = [-0.5, 0.6 * sideSign(side), -0.4];
      const c = cmd.arms[side];
      if (c.mode === 'fist') {
        c.fist = mix(c.fist, fist, w);
        c.pole = mix(c.pole, pole, w);
      } else if (w > 0.5) {
        c.mode = 'fist';
        c.fist = fist;
        c.pole = pole;
      }
    }
    // The waist: tuck into a backward fall (the back lands, not the head), turn onto the hip and the
    // shoulder in a forward or sideways one.
    const back = clamp(f.back, 0, 1);
    const turnSign = Math.abs(f.side) > 0.15 ? -Math.sign(f.side) : -1;
    pose.waistPitch += w * B.braceTuck * back;
    pose.waistYaw += w * B.braceTurn * turnSign * (1 - back);
  }

  /** After the IK: arms out (shoulder abduction) while recovering (not for a design that braces without its arms). */
  joints(react: Reactions, q: Float64Array): void {
    if (this.braceW > 0.5 || !this.braceArms) return;
    for (const side of SIDES) {
      const out = react.armsOut[side];
      if (out <= 0) continue;
      const i = this.roll[side];
      const lim = this.geo.limits.get(`shoulder_roll_${side}`);
      const v = q[i] + sideSign(side) * out;
      q[i] = lim ? clamp(v, lim.lo, lim.hi) : v;
    }
  }

  /**
   * Stiffness on top of the engine's (legs) and the strike drive's (a blow's damping): the absorbing
   * chain, the brace (arms stiff, legs soft), the pre-brace (guard and waist stiffer, not while `striking`).
   * `gait`: a planted leg never softens to absorb a blow.
   */
  impedance(react: Reactions, gait: Gait, striking: boolean): void {
    const kp = this.r.mem.gainScale as Float64Array | undefined;
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    if (!kp || !kv) return;
    const B = BEHAVIOURS;
    // The arms and waist are this layer's: back to as built unless something below changes them (the
    // strike drive rewrites only their damping).
    for (const side of SIDES) for (const i of this.arm[side]) kp[i] = 1;
    for (const i of this.waist) kp[i] = 1;
    if (this.braceW > 0.05) {
      const w = this.braceW;
      for (const side of SIDES) {
        for (const i of this.arm[side]) {
          kp[i] = B.braceArmKp;
          kv[i] = Math.max(kv[i], Math.sqrt(B.braceArmKp));
        }
        for (const i of this.leg[side]) {
          const v = 1 + (B.braceLegKp - 1) * w;
          kp[i] = Math.min(kp[i], v);
          kv[i] = Math.min(kv[i], Math.sqrt(v));
        }
      }
      return;
    }
    if (react.preBrace && !striking) {
      const v = REACTIONS.preStiff;
      for (const side of SIDES) for (const i of this.arm[side]) {
        kp[i] = v;
        kv[i] = Math.max(kv[i], Math.sqrt(v));
      }
      for (const i of this.waist) {
        kp[i] = v;
        kv[i] = Math.max(kv[i], Math.sqrt(v));
      }
    }
    const a = react.absorbScale;
    if (a < 1 && react.absorbPart) {
      const chain = this.chainOf(react.absorbPart, gait);
      if (chain) for (const i of chain) {
        kp[i] = Math.min(kp[i], a);
        kv[i] = Math.min(kv[i], Math.sqrt(a));
      }
    }
  }

  /** On the canvas after a braced fall: arms held stiff and legs soft while the settle holds the catch. */
  holdImpedance(on: boolean): void {
    const kp = this.r.mem.gainScale as Float64Array | undefined;
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    if (!kp || !kv) return;
    kp.fill(1);
    kv.fill(1);
    if (!on) return;
    const B = BEHAVIOURS;
    for (const side of SIDES) for (const i of this.leg[side]) {
      kp[i] = B.braceLegKp;
      kv[i] = Math.sqrt(B.braceLegKp);
    }
  }

  /** The joints a hit on `part` gives with (null: none, e.g. a stance leg). */
  private chainOf(part: string, gait: Gait): Int16Array | null {
    const m = /_([lr])$/.exec(part);
    const side = m ? (m[1] as Side) : null;
    if (/^(upperarm|forearm|fist|hand)/.test(part) && side) return this.arm[side];
    if (/^(thigh|shin|foot)/.test(part) && side) return gait.planted(side) ? null : this.leg[side];
    return this.waist;
  }
}
