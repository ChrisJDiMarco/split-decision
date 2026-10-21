// The striking fist's path on the balance engine (docs/design/strike-power.md §2.1-2.4, balance-engine
// §5.2): a punch is driven, not replayed. When the strike phase starts the fist leaves where it is (the
// guard) on a line to an aim point locked in the world STRIKE_PATH.throughM past the first surface in
// its way (his guard, else the target), bent by the clip's own arc (a hook's loop, an uppercut's scoop),
// and ending short of the elbow's stop. Its clock is a time-optimal scaling on the arm's real dynamics,
// every control tick:
//   s̈ = min_i (κ·τ_avail,i(|q'_i·ṡ|) − sgn(q'_i)·bias_i) / (M_ii·|q'_i|),   |q'_i·ṡ| ≤ speedCap·ω_noload,i
// with q(s) the arm IK along the path, q' its slope, M_ii the joint-space inertia's diagonal (the whole
// subtree the joint swings, rotor included), bias the gravity and Coriolis torque, τ_avail the motor's
// torque-speed line scaled by health and battery. So the fist accelerates as hard as the slowest of its
// joints' real motors allows, all the way into the target: peak speed at contact, not a replay of the
// actor's speed curve braking into the surface. Nothing is added to the physics: the servo gets the
// path as targets (with the velocity and inertia feed-forward the controller already gives a blow).
import type { Vec3 } from '../../core/types';
import type { LegGeometry, Side } from './geometry';
import { armFK, armIK, clampAngle, legFK, legIKPoint, newArmAngles, newLegAngles, type ArmAngles, type LegAngles } from './ik';
import { clamp, minJerk, mulMtV, sub } from './math';
import type { SkillEnv } from './skills/types';

/** Tunables (exported so tools can sweep them; the worker never changes them). */
export const STRIKE_PATH = {
  // Share of the torque-speed line the time scaling plans with: all of it (the path runs at the motors' real
  // limit; a target the arm cannot follow the servo chases at full torque, which is the same limit).
  kappa: 1,
  speedCap: 1, // × no-load speed (the line itself gives no torque there)
  throughM: 0.3, // the aim point sits this far past the first surface (strike-power §2.2: 0.25-0.35)
  elbowEndRad: -0.17, // the path ends with the elbow this far from straight (near, never into, its stop: §2.4)
  kneeEndRad: 0.2, // ...and a kick's with the knee this far from straight
  minRate: 0.6, // path fraction per second the clock never drops below (the blow never stalls)
  leadS: 0.008, // the servo target runs this far ahead on the path
  arc: 0.6, // share of the clip's own bend off its chord (a hook's loop) kept on the robot's path
  poleShare: 0.3, // the elbow's direction at the impact: this share of the clip's, the rest the guard's (elbow down)
  maxArcChordM: 0.8, // the bend scales with the robot's chord, up to this long
  estimateDtS: 0.004, // step of the time-to-contact estimate
  estimateMaxS: 0.5,
};

const H = 0.03; // path step for the IK slope

/** The robot's dynamics now (SkillEnv.dyn): r.joints indices. */
export interface JointDynamics {
  /** Joint-space inertia, diagonal entry (kg·m²). */
  inertia(i: number): number;
  /** Bias torque (gravity, Coriolis), MuJoCo's qfrc_bias, N·m. */
  bias(i: number): number;
  /** Share of the motor's torque that health and battery leave (0..1). */
  torqueScale(i: number): number;
}

/** The clip's bend off its own chord, sampled over the strike (torso frame, m per unit chord). */
export interface ArcTable {
  n: number;
  dev: Float64Array; // 3 × n
}

const tmpA = newArmAngles();
const tmpB = newArmAngles();
const legA = newLegAngles();
const legB = newLegAngles();

/**
 * A blow's path (above): the fist in the torso frame (arm: shoulder pitch, roll, yaw, elbow), or a kick's
 * ankle in the measured pelvis frame (leg: hip yaw, roll, pitch, knee; the ankle's own angles are the
 * caller's).
 */
export class FistPath {
  side: Side = 'l';
  limb: 'arm' | 'leg' = 'arm';
  /** Path parameter (0 at the start, 1 at the end point) and its rate (1/s). */
  s = 0;
  sd = 0;
  /** Path parameter where the planned first contact lies (> 1: out of reach). */
  sContact = 1;
  /** Seconds from the start to the planned contact (estimate, at the start). */
  tContact = 0.15;
  /** Wall seconds since the start. */
  t = 0;
  /** Diagnostics: the arm joint (0 pitch, 1 roll, 2 yaw, 3 elbow) that bound the path's acceleration and its rate last tick, −1 none. */
  bindAcc = -1;
  bindCap = -1;
  /** The aim point, world (locked at the start). */
  readonly aimWorld: Vec3 = [0, 0, 0];
  /** The planned first contact, world. */
  readonly contactWorld: Vec3 = [0, 0, 0];
  /** Where the fist starts (torso frame). */
  readonly start: Vec3 = [0, 0, 0];
  /** Commanded fist this tick (torso frame) and the arm angles for it. */
  readonly fist: Vec3 = [0, 0, 0];
  readonly angles: ArmAngles = newArmAngles();
  /** A kick's leg angles for the commanded ankle (hip yaw, roll, pitch, knee; the ankle's are left). */
  readonly leg: LegAngles = newLegAngles();
  private readonly poleFrom: Vec3 = [0, 0, -1];
  private readonly poleTo: Vec3 = [0, 0, -1];
  private arc: ArcTable | null = null;
  private arcScale = 1;
  private readonly idx: number[] = [];
  private readonly names: string[] = [];
  private readonly end: Vec3 = [0, 0, 0];
  private readonly p: Vec3 = [0, 0, 0];
  /** The limb's base (shoulder or hip, its frame) and its reach to the path's end (elbow / knee at its end bend). */
  private readonly base: Vec3 = [0, 0, 0];
  private reach = 1;
  /** The path's length, start to end point (m). */
  get length(): number {
    return Math.hypot(this.end[0] - this.start[0], this.end[1] - this.start[1], this.end[2] - this.start[2]);
  }
  private readonly pole: Vec3 = [0, 0, -1];
  private readonly dq = new Float64Array(4);
  private readonly lim = { acc: 0, cap: 0 };

  /**
   * Start the strike: from `from` (torso frame) toward `contact` (world, the first surface), aiming
   * STRIKE_PATH.throughM past it; the elbow pole blends from `poleFrom` to `poleTo` (torso frame).
   * `lead`: the target's velocity (world, m/s), the aim is led by it over the estimated flight.
   */
  begin(env: SkillEnv, side: Side, from: Vec3, contact: Vec3, poleFrom: Vec3, poleTo: Vec3, arc: ArcTable | null, lead: Vec3, limb: 'arm' | 'leg' = 'arm'): void {
    this.side = side;
    this.limb = limb;
    this.s = 0;
    this.sd = STRIKE_PATH.minRate;
    this.t = 0;
    copy(this.start, from);
    copy(this.poleFrom, poleFrom);
    copy(this.poleTo, poleTo);
    this.arc = arc;
    this.idx.length = 0;
    this.names.length = 0;
    if (limb === 'arm') {
      const m = env.jm.arm[side];
      this.idx.push(m.pitch, m.roll, m.yaw, m.elbow);
      this.names.push(`shoulder_pitch_${side}`, `shoulder_roll_${side}`, `shoulder_yaw_${side}`, `elbow_${side}`);
    } else {
      const m = env.jm.leg[side];
      this.idx.push(m.hipYaw, m.hipRoll, m.hipPitch, m.knee);
      this.names.push(`hip_yaw_${side}`, `hip_roll_${side}`, `hip_pitch_${side}`, `knee_${side}`);
    }
    // The aim: through the first surface along the line from the fist (or ankle), in the world.
    const fw = this.toWorld(env, from);
    const d: Vec3 = [contact[0] - fw[0], contact[1] - fw[1], contact[2] - fw[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const k = (len + STRIKE_PATH.throughM) / len;
    copy(this.contactWorld, contact);
    for (let i = 0; i < 3; i++) this.aimWorld[i] = fw[i] + d[i] * k;
    this.arcScale = arc ? Math.min(STRIKE_PATH.maxArcChordM, len) : 0;
    this.updateEnd(env);
    this.tContact = this.estimate(env);
    // Lead a moving target over the flight (horizontal only).
    this.aimWorld[0] += lead[0] * this.tContact;
    this.aimWorld[1] += lead[1] * this.tContact;
    this.contactWorld[0] += lead[0] * this.tContact;
    this.contactWorld[1] += lead[1] * this.tContact;
    this.updateEnd(env);
    this.write(env, 0);
  }

  /** The limb's targets for the path point at `s`. */
  private write(env: SkillEnv, s: number): void {
    if (this.limb === 'arm') this.solve(env, s, this.angles, this.fist);
    else this.solveLeg(env, s, this.leg, this.fist);
  }

  /** World point → the limb's frame (torso for an arm, the measured pelvis for a leg). */
  private toFrame(env: SkillEnv, p: Vec3): Vec3 {
    return this.limb === 'arm' ? env.toTorso(p) : mulMtV(env.s.pelvisRot, sub(p, env.s.pelvisPos));
  }

  private toWorld(env: SkillEnv, p: Vec3): Vec3 {
    const arm = this.limb === 'arm';
    const R = arm ? env.s.torsoRot : env.s.pelvisRot, o = arm ? env.s.torsoPos : env.s.pelvisPos;
    return [
      o[0] + R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
      o[1] + R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
      o[2] + R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
    ];
  }

  /** The end point in the limb's frame now: the aim, clipped where the elbow (knee) reaches its end. */
  private updateEnd(env: SkillEnv): void {
    const a = this.toFrame(env, this.aimWorld);
    let sh: Vec3, U: number, F: number, bend: number;
    if (this.limb === 'arm') {
      const arm = env.geo.arms[this.side];
      sh = arm.shoulder;
      U = arm.upper;
      F = arm.fore;
      bend = STRIKE_PATH.elbowEndRad;
    } else {
      const leg = env.geo.legs[this.side];
      sh = leg.hip;
      U = leg.thigh;
      F = leg.shin;
      bend = STRIKE_PATH.kneeEndRad;
    }
    const dExt = Math.sqrt(U * U + F * F + 2 * U * F * Math.cos(bend));
    copy(this.base, sh);
    this.reach = dExt;
    // Largest k in [0, 1] with |start + k(a − start) − shoulder| ≤ dExt.
    const ox = this.start[0] - sh[0], oy = this.start[1] - sh[1], oz = this.start[2] - sh[2];
    const vx = a[0] - this.start[0], vy = a[1] - this.start[1], vz = a[2] - this.start[2];
    const A = vx * vx + vy * vy + vz * vz;
    const B = 2 * (ox * vx + oy * vy + oz * vz);
    const C = ox * ox + oy * oy + oz * oz - dExt * dExt;
    let k = 1;
    if (A > 1e-9) {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const hi = (-B + Math.sqrt(disc)) / (2 * A);
        k = clamp(hi, 0, 1);
      } else k = 0;
    }
    this.end[0] = this.start[0] + k * vx;
    this.end[1] = this.start[1] + k * vy;
    this.end[2] = this.start[2] + k * vz;
    // Where the planned contact lies along this path.
    const c = this.toFrame(env, this.contactWorld);
    const cl = Math.hypot(c[0] - this.start[0], c[1] - this.start[1], c[2] - this.start[2]);
    const el = Math.hypot(this.end[0] - this.start[0], this.end[1] - this.start[1], this.end[2] - this.start[2]);
    this.sContact = el > 1e-6 ? cl / el : 1;
  }

  /** The path point at `s` (torso frame) into `out`. */
  private point(s: number, out: Vec3): Vec3 {
    for (let i = 0; i < 3; i++) out[i] = this.start[i] + s * (this.end[i] - this.start[i]);
    const arc = this.arc;
    if (arc && arc.n > 1 && STRIKE_PATH.arc > 0) {
      // The clip's bend at the same share of its way to the impact (none past the contact).
      const u = clamp(s / Math.max(1e-3, Math.min(1, this.sContact)), 0, 1) * (arc.n - 1);
      const i0 = Math.min(arc.n - 2, Math.floor(u)), w = u - i0;
      const k = STRIKE_PATH.arc * this.arcScale;
      for (let j = 0; j < 3; j++) out[j] += k * (arc.dev[3 * i0 + j] * (1 - w) + arc.dev[3 * (i0 + 1) + j] * w);
      // The bend never carries the path past the limb's reach (a straight knee or elbow is a singularity).
      const b = this.base;
      const dx = out[0] - b[0], dy = out[1] - b[1], dz = out[2] - b[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > this.reach) {
        const q = this.reach / d;
        out[0] = b[0] + dx * q;
        out[1] = b[1] + dy * q;
        out[2] = b[2] + dz * q;
      }
    }
    return out;
  }

  /** Arm angles (joint-limited) for the path point at `s`. */
  private solve(env: SkillEnv, s: number, out: ArmAngles, fist?: Vec3): ArmAngles {
    const p = this.point(clamp(s, 0, 1), this.p);
    if (fist) copy(fist, p);
    const w = minJerk(clamp(s, 0, 1));
    const pole = this.pole;
    for (let i = 0; i < 3; i++) pole[i] = this.poleFrom[i] + (this.poleTo[i] - this.poleFrom[i]) * w;
    armIK(env.geo.arms[this.side], p, pole, out);
    const sd = this.side;
    out.pitch = clampAngle(out.pitch, env.geo.limits.get(`shoulder_pitch_${sd}`));
    out.roll = clampAngle(out.roll, env.geo.limits.get(`shoulder_roll_${sd}`));
    out.yaw = clampAngle(out.yaw, env.geo.limits.get(`shoulder_yaw_${sd}`));
    out.elbow = clampAngle(out.elbow, env.geo.limits.get(`elbow_${sd}`));
    return out;
  }

  /** Leg angles (joint-limited; hips and knee) for the path point at `s`. */
  private solveLeg(env: SkillEnv, s: number, out: LegAngles, ankle?: Vec3): LegAngles {
    const p = this.point(clamp(s, 0, 1), this.p);
    if (ankle) copy(ankle, p);
    const w = minJerk(clamp(s, 0, 1));
    const pole = this.pole;
    for (let i = 0; i < 3; i++) pole[i] = this.poleFrom[i] + (this.poleTo[i] - this.poleFrom[i]) * w;
    // (A blend between two far-apart poles passes near zero: keep it a direction.)
    const pn = Math.hypot(pole[0], pole[1], pole[2]);
    if (pn > 1e-6) for (let i = 0; i < 3; i++) pole[i] /= pn;
    legIKPoint(env.geo.legs[this.side], p, pole, out);
    const sd = this.side;
    out.hipYaw = clampAngle(out.hipYaw, env.geo.limits.get(`hip_yaw_${sd}`));
    out.hipRoll = clampAngle(out.hipRoll, env.geo.limits.get(`hip_roll_${sd}`));
    out.hipPitch = clampAngle(out.hipPitch, env.geo.limits.get(`hip_pitch_${sd}`));
    out.knee = clampAngle(out.knee, env.geo.limits.get(`knee_${sd}`));
    return out;
  }

  /** The fastest the motors allow along the path at (s, ṡ): the path acceleration and the rate cap. */
  private limits(env: SkillEnv, s: number, sd: number, out: { acc: number; cap: number }): void {
    const dyn = env.dyn!;
    const sa = Math.min(s, 1 - H);
    const dq = this.dq;
    if (this.limb === 'arm') {
      this.solve(env, sa, tmpA);
      this.solve(env, sa + H, tmpB);
      dq[0] = (tmpB.pitch - tmpA.pitch) / H;
      dq[1] = (tmpB.roll - tmpA.roll) / H;
      dq[2] = (tmpB.yaw - tmpA.yaw) / H;
      dq[3] = (tmpB.elbow - tmpA.elbow) / H;
    } else {
      this.solveLeg(env, sa, legA);
      this.solveLeg(env, sa + H, legB);
      dq[0] = (legB.hipYaw - legA.hipYaw) / H;
      dq[1] = (legB.hipRoll - legA.hipRoll) / H;
      dq[2] = (legB.hipPitch - legA.hipPitch) / H;
      dq[3] = (legB.knee - legA.knee) / H;
    }
    let acc = Infinity, cap = Infinity;
    this.bindAcc = this.bindCap = -1;
    for (let k = 0; k < 4; k++) {
      const q1 = Math.abs(dq[k]);
      if (q1 < 1e-3) continue;
      const i = this.idx[k];
      const j = env.joint(this.names[k]);
      if (!j) continue;
      const w0 = j.motor.noLoadSpeedRadS;
      const c = (STRIKE_PATH.speedCap * w0) / q1;
      if (c < cap) {
        cap = c;
        this.bindCap = k;
      }
      const tau = STRIKE_PATH.kappa * j.motor.stallTorqueNm * dyn.torqueScale(i) * Math.max(0.05, 1 - (q1 * sd) / w0);
      const a = (tau - Math.sign(dq[k]) * dyn.bias(i)) / (Math.max(1e-4, dyn.inertia(i)) * q1);
      if (a < acc) {
        acc = a;
        this.bindAcc = k;
      }
    }
    out.acc = Number.isFinite(acc) ? acc : 0;
    out.cap = cap;
  }

  /** Seconds to reach the planned contact from here at the motors' pace (or to the end of the path). */
  private estimate(env: SkillEnv): number {
    let s = 0, sd = this.sd, t = 0;
    const dt = STRIKE_PATH.estimateDtS;
    const lim = this.lim;
    const goal = Math.min(1, this.sContact);
    while (s < goal && t < STRIKE_PATH.estimateMaxS) {
      this.limits(env, s, sd, lim);
      sd = clamp(sd + lim.acc * dt, STRIKE_PATH.minRate, lim.cap);
      s += sd * dt;
      t += dt;
    }
    return t;
  }

  /** Advance the path one control tick; writes `fist` and `angles` (the arm's targets). */
  step(env: SkillEnv, dt: number): void {
    this.t += dt;
    this.updateEnd(env);
    const lim = this.lim;
    this.limits(env, this.s, this.sd, lim);
    this.sd = clamp(this.sd + lim.acc * dt, STRIKE_PATH.minRate, lim.cap);
    this.s = Math.min(1, this.s + this.sd * dt);
    this.write(env, Math.min(1, this.s + this.sd * STRIKE_PATH.leadS));
  }

  get done(): boolean {
    return this.s >= 1;
  }
}

function copy(out: Vec3, v: readonly number[]): Vec3 {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
  return out;
}

/** The clip's bend off its chord between clip times `from` and `to` (torso frame), per unit chord length. */
export function arcTable(fistAt: (tau: number) => Vec3, from: number, to: number, n = 12): ArcTable | null {
  if (!(to > from)) return null;
  const a = fistAt(from), b = fistAt(to);
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (L2 < 1e-6) return null;
  const L = Math.sqrt(L2);
  const dev = new Float64Array(3 * n);
  for (let k = 0; k < n; k++) {
    const f = fistAt(from + ((to - from) * k) / (n - 1));
    const rel: Vec3 = [f[0] - a[0], f[1] - a[1], f[2] - a[2]];
    const prog = (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / L2;
    for (let j = 0; j < 3; j++) dev[3 * k + j] = (rel[j] - prog * d[j]) / L;
  }
  return { n, dev };
}

/** Elbow pole of an arm pose (torso frame): the elbow off the shoulder-fist midline. */
export function elbowPole(env: SkillEnv, side: Side, a: ArmAngles): Vec3 {
  const fk = armFK(env.geo.arms[side], a);
  const sh = env.geo.arms[side].shoulder;
  const p: Vec3 = [fk.elbow[0] - (sh[0] + fk.fist[0]) / 2, fk.elbow[1] - (sh[1] + fk.fist[1]) / 2, fk.elbow[2] - (sh[2] + fk.fist[2]) / 2];
  const n = Math.hypot(p[0], p[1], p[2]);
  return n > 1e-6 ? [p[0] / n, p[1] / n, p[2] / n] : [0, 0, -1];
}

/**
 * A kick's drive (balance engine): from lift-off the kicking leg runs a smooth curve in JOINT space (hip
 * yaw, roll, pitch, knee): a quadratic Bézier from where it stands, through the clip's chamber (its most
 * folded knee on the way out, at the curve's middle), to the pose that puts its ankle
 * STRIKE_PATH.throughM past his surface (the leg IK, the knee pointing as the clip's does at its impact,
 * re-solved every tick in the measured pelvis frame as the hips turn over). A kick chambers and unfolds
 * joint by joint, not along a line in space. The clock is the same time-optimal scaling as a punch's, on
 * the leg's motors: s̈ = min_i (κ·τ_avail,i − sgn(q'_i)·bias_i) / (M_ii·|q'_i|), |q'_i·ṡ| ≤ speedCap·ω_noload,i.
 */
export class JointPath {
  side: Side = 'r';
  s = 0;
  sd = 0;
  t = 0;
  /** Path parameter where the ankle passes nearest his surface (the clip's impact frame lands there). */
  sContact = 1;
  readonly aimWorld: Vec3 = [0, 0, 0];
  readonly start: LegAngles = newLegAngles();
  readonly end: LegAngles = newLegAngles();
  readonly leg: LegAngles = newLegAngles();
  /** The Bézier's control pose (it passes the chamber at s = 0.5); the start when there is no chamber. */
  private readonly ctrl: LegAngles = newLegAngles();
  private readonly chamber: LegAngles = newLegAngles();
  private hasChamber = false;
  private readonly pole: Vec3 = [1, 0, 0];
  private readonly idx: number[] = [];
  private readonly names: string[] = [];
  private readonly dq = new Float64Array(4);

  begin(env: SkillEnv, side: Side, start: LegAngles, chamber: LegAngles | null, contact: Vec3, pole: Vec3, lead: Vec3): void {
    this.side = side;
    this.s = 0;
    this.sd = STRIKE_PATH.minRate;
    this.t = 0;
    Object.assign(this.start, start);
    this.hasChamber = !!chamber;
    if (chamber) Object.assign(this.chamber, chamber);
    copy(this.pole, pole);
    const m = env.jm.leg[side];
    this.idx.length = 0;
    this.idx.push(m.hipYaw, m.hipRoll, m.hipPitch, m.knee);
    this.names.length = 0;
    this.names.push(`hip_yaw_${side}`, `hip_roll_${side}`, `hip_pitch_${side}`, `knee_${side}`);
    // The aim: past the surface along the line from where the ankle starts, led by his motion.
    const lg = env.geo.legs[side];
    const a0 = this.toWorld(env, legFKAnkle(lg, start));
    const d: Vec3 = [contact[0] - a0[0], contact[1] - a0[1], contact[2] - a0[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const k = (len + STRIKE_PATH.throughM) / len;
    for (let i = 0; i < 3; i++) this.aimWorld[i] = a0[i] + d[i] * k + lead[i] * 0.25;
    this.solveEnd(env);
    // Where along the joint line the ankle passes nearest the surface (sampled).
    const c = mulMtV(env.s.pelvisRot, sub(contact, env.s.pelvisPos));
    let best = Infinity;
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      this.at(s, legA);
      const p = legFKAnkle(lg, legA);
      const dd = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      if (dd < best) {
        best = dd;
        this.sContact = Math.max(0.3, s);
      }
    }
    this.at(0, this.leg);
  }

  /** The curve's control pose: through the chamber at s = 0.5 (P1 = 2·chamber − (start + end)/2). */
  private updateCtrl(): void {
    if (!this.hasChamber) {
      Object.assign(this.ctrl, this.start);
      return;
    }
    const a = this.start, b = this.end, c = this.chamber, o = this.ctrl;
    o.hipYaw = 2 * c.hipYaw - (a.hipYaw + b.hipYaw) / 2;
    o.hipRoll = 2 * c.hipRoll - (a.hipRoll + b.hipRoll) / 2;
    o.hipPitch = 2 * c.hipPitch - (a.hipPitch + b.hipPitch) / 2;
    o.knee = 2 * c.knee - (a.knee + b.knee) / 2;
    o.anklePitch = c.anklePitch;
    o.ankleRoll = c.ankleRoll;
  }

  /** The pose at `s` (quadratic Bézier start → ctrl → end). */
  private at(s: number, out: LegAngles): LegAngles {
    const u = clamp(s, 0, 1), a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    const p = this.start, q = this.ctrl, r = this.end;
    out.hipYaw = a * p.hipYaw + b * q.hipYaw + c * r.hipYaw;
    out.hipRoll = a * p.hipRoll + b * q.hipRoll + c * r.hipRoll;
    out.hipPitch = a * p.hipPitch + b * q.hipPitch + c * r.hipPitch;
    out.knee = a * p.knee + b * q.knee + c * r.knee;
    out.anklePitch = a * p.anklePitch + b * q.anklePitch + c * r.anklePitch;
    out.ankleRoll = a * p.ankleRoll + b * q.ankleRoll + c * r.ankleRoll;
    return out;
  }

  /** The curve's slope at `s` into dq (hip yaw, roll, pitch, knee). */
  private slope(s: number): void {
    const u = clamp(s, 0, 1), dq = this.dq, p = this.start, q = this.ctrl, r = this.end;
    const ka = 2 * (1 - u), kb = 2 * u;
    dq[0] = ka * (q.hipYaw - p.hipYaw) + kb * (r.hipYaw - q.hipYaw);
    dq[1] = ka * (q.hipRoll - p.hipRoll) + kb * (r.hipRoll - q.hipRoll);
    dq[2] = ka * (q.hipPitch - p.hipPitch) + kb * (r.hipPitch - q.hipPitch);
    dq[3] = ka * (q.knee - p.knee) + kb * (r.knee - q.knee);
  }

  private toWorld(env: SkillEnv, p: Vec3): Vec3 {
    const R = env.s.pelvisRot, o = env.s.pelvisPos;
    return [
      o[0] + R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
      o[1] + R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
      o[2] + R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
    ];
  }

  /** The end pose: the aim (measured pelvis frame), clipped to the knee's end bend. */
  private solveEnd(env: SkillEnv): void {
    const lg = env.geo.legs[this.side];
    const a = mulMtV(env.s.pelvisRot, sub(this.aimWorld, env.s.pelvisPos));
    const dExt = Math.sqrt(lg.thigh * lg.thigh + lg.shin * lg.shin + 2 * lg.thigh * lg.shin * Math.cos(STRIKE_PATH.kneeEndRad));
    const h = lg.hip;
    const v: Vec3 = [a[0] - h[0], a[1] - h[1], a[2] - h[2]];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n > dExt) for (let i = 0; i < 3; i++) a[i] = h[i] + (v[i] * dExt) / n;
    legIKPoint(lg, a, this.pole, this.end);
    const sd = this.side;
    this.end.hipYaw = clampAngle(this.end.hipYaw, env.geo.limits.get(`hip_yaw_${sd}`));
    this.end.hipRoll = clampAngle(this.end.hipRoll, env.geo.limits.get(`hip_roll_${sd}`));
    this.end.hipPitch = clampAngle(this.end.hipPitch, env.geo.limits.get(`hip_pitch_${sd}`));
    this.end.knee = clampAngle(this.end.knee, env.geo.limits.get(`knee_${sd}`));
    this.end.anklePitch = this.start.anklePitch;
    this.end.ankleRoll = this.start.ankleRoll;
    this.updateCtrl();
  }

  step(env: SkillEnv, dt: number): void {
    this.t += dt;
    this.solveEnd(env);
    this.slope(this.s);
    const dq = this.dq;
    const dyn = env.dyn!;
    let acc = Infinity, cap = Infinity;
    for (let k = 0; k < 4; k++) {
      const q1 = Math.abs(dq[k]);
      if (q1 < 1e-3) continue;
      const j = env.joint(this.names[k]);
      if (!j) continue;
      const i = this.idx[k];
      const w0 = j.motor.noLoadSpeedRadS;
      cap = Math.min(cap, (STRIKE_PATH.speedCap * w0) / q1);
      const tau = STRIKE_PATH.kappa * j.motor.stallTorqueNm * dyn.torqueScale(i) * Math.max(0.05, 1 - (q1 * this.sd) / w0);
      acc = Math.min(acc, (tau - Math.sign(dq[k]) * dyn.bias(i)) / (Math.max(1e-4, dyn.inertia(i)) * q1));
    }
    if (!Number.isFinite(acc)) acc = 0;
    this.sd = clamp(this.sd + acc * dt, STRIKE_PATH.minRate, cap);
    this.s = Math.min(1, this.s + this.sd * dt);
    this.at(Math.min(1, this.s + this.sd * STRIKE_PATH.leadS), this.leg);
  }

  get done(): boolean {
    return this.s >= 1;
  }
}


function legFKAnkle(leg: LegGeometry, a: LegAngles): Vec3 {
  return legFK(leg, a).ankle;
}
