// Rollouts: PolishedPlayer → the game's motor model → mj_step, every step, with the cost of
// move-polish.md §4 sampled every 10 ms against the reference at the clip time the player has reached.
// The same loop records nominals (for the feedback), snapshots (window starts) and dense traces
// (measurement and the comparison view).
import { CONTACT, sample, type MotionSample, newSample } from '../../src/robots/motions';
import type { Mat3 } from '../../src/physics/control/math';
import { CONTROL_DT, PolishedPlayer } from '../../src/robots/motions/polish/player';
import { NOMINAL_STRIDE } from '../../src/robots/motions/polish/format';
import { FOOT_BITS, HAND_BITS, KNEE_BITS, refAt, refContacts, type Reference } from './reference';
import { lowestGeomZ, physicsStep, readSense, snapshot, type PolishWorld, type Snapshot } from './world';

export const SAMPLE_STEPS = 10; // cost / trace sample every 10 ms
const STEPS_PER_TICK = 2;
const TICKS_PER_NOMINAL = 2; // NOMINAL_HZ = 250

// ---------------------------------------------------------------- perturbations (scenarios, validation)

export interface Perturb {
  /** Torso push: world force (N) held for `dur` s from wall time `t` after the clock started. */
  push?: { t: number; fx: number; fy: number; dur: number };
  damage?: Array<{ joint: number; health: number; slop: number }>;
  heatC?: number;
  battery?: number;
  gyroHealth?: number;
  /** Servo targets reach the motors this many control ticks late. */
  latencyTicks?: number;
  /** Velocity kick at the start of the run: pelvis linear (m/s) and angular (rad/s) velocity added. */
  kick?: { vx: number; vy: number; wx: number; wy: number };
  rngSeed?: number;
}

export function applyStartPerturb(w: PolishWorld, p: Perturb | undefined): void {
  if (!p) return;
  const r = w.r;
  if (p.damage) for (const d of p.damage) {
    const j = r.joints[d.joint];
    j.health = Math.min(j.health, d.health);
    j.slop = Math.max(j.slop, d.slop);
    j.state = j.health <= 0.05 ? 'limp' : j.health <= 0.35 ? 'degraded' : 'ok';
  }
  if (p.heatC !== undefined) for (const j of r.joints) j.tempC = Math.max(j.tempC, p.heatC);
  if (p.battery !== undefined) r.battery = Math.min(r.battery, p.battery);
  if (p.gyroHealth !== undefined && r.gyro) r.gyro.health = Math.min(r.gyro.health, p.gyroHealth);
  if (p.rngSeed !== undefined) w.rng.s = p.rngSeed >>> 0;
  if (p.kick) {
    const v = w.ctx.data.qvel as Float64Array;
    const a = r.rootDadr;
    v[a] += p.kick.vx;
    v[a + 1] += p.kick.vy;
    // Free-joint angular velocity is in the body frame; a small kick about local x/y is close enough.
    v[a + 3] += p.kick.wx;
    v[a + 4] += p.kick.wy;
  }
}

// ---------------------------------------------------------------- cost (move-polish.md §4)

export const WEIGHTS = {
  pose: 8, root: 8, com: 3, tilt: 10, heading: 6, ee: 20, slip: 30, contacts: 5, balance: 20, buzz: 2, headroom: 10, effort: 0.5, gyro: 5,
  impact: 20, terminal: 20,
};
export type Term = 'pose' | 'root' | 'com' | 'tilt' | 'heading' | 'ee' | 'slip' | 'contacts' | 'balance' | 'buzz' | 'headroom' | 'effort' | 'gyro';
export const TERMS: Term[] = ['pose', 'root', 'com', 'tilt', 'heading', 'ee', 'slip', 'contacts', 'balance', 'buzz', 'headroom', 'effort', 'gyro'];
export const FALL_COST = 1000;

export interface CostResult {
  total: number;
  terms: Record<Term, number>; // weighted means
  impact: number;
  terminal: number;
  fell: boolean;
  fellTau: number;
  samples: number;
  impactErr: number;
  impactSpeed: number;
  endTau: number;
}

export class CostAcc {
  readonly sums: Record<Term, number> = Object.fromEntries(TERMS.map((t) => [t, 0])) as Record<Term, number>;
  weight = 0;
  fell = false;
  fellTau = -1;
  impact = 0;
  impactDone = false;
  impactErr = -1;
  impactSpeed = -1;
  terminal = 0;
  terminalDone = false;
  lastTau = 0;
  prevTau = -1;
  /** Bottom corners of both soles at the last sample (slip is measured at the touching corner). */
  prevCorners = new Float64Array(24);
  // derivative / filter state
  prevSole = new Float64Array(6);
  prevStriker = new Float64Array(3);
  hasPrev = false;
  lp = new Float64Array(3);
  hasLp = false;
  mismatch = [0, 0];
  getupRose = false;
  getupLostS = 0;
  readonly s: MotionSample;

  constructor(readonly ref: Reference, readonly fromTau: number, readonly lookaheadTau: number, readonly endTau: number, nLib: number, readonly poseScale = 1) {
    this.s = newSample(nLib);
  }

  result(): CostResult {
    const terms = {} as Record<Term, number>;
    let total = 0;
    const n = Math.max(1e-9, this.weight);
    for (const t of TERMS) {
      const v = this.weight > 0 ? (WEIGHTS[t] * this.sums[t]) / n : 0;
      terms[t] = v;
      total += v;
    }
    total += this.impact + this.terminal;
    if (this.fell) {
      const span = Math.max(1e-6, this.endTau - this.fromTau);
      total += FALL_COST * (1 + Math.max(0, Math.min(1, (this.endTau - this.fellTau) / span)));
    }
    return {
      total, terms, impact: this.impact, terminal: this.terminal, fell: this.fell, fellTau: this.fellTau, samples: this.weight,
      impactErr: this.impactErr, impactSpeed: this.impactSpeed, endTau: this.lastTau,
    };
  }
}

/** Unplanned-contact classes: which clip contact bit allows a part on the canvas. */
function partBit(part: string): number {
  if (part.startsWith('fist') || part.startsWith('forearm')) return part.endsWith('_l') ? CONTACT.HAND_L : CONTACT.HAND_R;
  if (part.startsWith('shin') || part.startsWith('thigh')) return part.endsWith('_l') ? CONTACT.KNEE_L : CONTACT.KNEE_R;
  if (part === 'pelvis') return CONTACT.HIPS;
  if (part.startsWith('foot')) return part.endsWith('_l') ? CONTACT.FOOT_L : CONTACT.FOOT_R;
  return CONTACT.CHEST; // torso, head, upper arms
}

const TOUCH_M = 0.012; // a geom this close to the canvas is touching it
/** Per-sample cap on each term (a toppling body should not out-shout the fall penalty). */
const CAP = 25;

/** One cost sample at the player's current clip time. */
function costSample(w: PolishWorld, pl: PolishedPlayer, acc: CostAcc): void {
  const ref = acc.ref;
  const tau = pl.tau;
  acc.lastTau = tau;
  const d = w.ctx.data;
  const xp = d.xpos as Float64Array, xm = d.xmat as Float64Array, gx = d.geom_xpos as Float64Array, gm = d.geom_xmat as Float64Array;
  const sc = d.subtree_com as Float64Array, cvel = d.cvel as Float64Array, qpos = d.qpos as Float64Array;
  const ids = w.ids, r = w.r, sense = w.sense;
  const dtS = SAMPLE_STEPS * 0.001;
  // Torso up-axis, fall checks first.
  const up = xm[ids.torso * 9 + 8];
  const clipBits = refContacts(ref, Math.min(tau, ref.move.duration));
  const getup = ref.kind === 'getup';
  if (!getup) {
    // Fallen (or past saving): torso more than 60° off vertical, or more than 45° off the clip's torso.
    const tc = Math.min(tau, ref.move.duration);
    const ux = xm[ids.torso * 9 + 2], uy = xm[ids.torso * 9 + 5];
    const rx = refAt(ref.torsoUp, 3, ref, tc, 0), ry = refAt(ref.torsoUp, 3, ref, tc, 1), rz = refAt(ref.torsoUp, 3, ref, tc, 2);
    const cosRel = (ux * rx + uy * ry + up * rz) / Math.max(1e-9, Math.hypot(rx, ry, rz));
    if (up < 0.5 || cosRel < Math.SQRT1_2) {
      acc.fell = true;
      acc.fellTau = tau;
      return;
    }
    for (const g of w.robotGeoms) {
      const part = w.geomPart.get(g)!;
      if (part.startsWith('foot')) continue;
      if (lowestGeomZ(w, g, gx, gm) < TOUCH_M && !(clipBits & partBit(part))) {
        acc.fell = true;
        acc.fellTau = tau;
        return;
      }
    }
  } else {
    // A get-up has failed once it has risen and then sinks well below the clip, or ends lying.
    const cz = sc[ids.root * 3 + 2];
    const refZ = refAt(ref.com, 3, ref, tau, 2);
    if (refZ > 0.6 * ref.standComZ) acc.getupRose = true;
    if (acc.getupRose && cz < refZ - 0.25) acc.getupLostS += dtS;
    else acc.getupLostS = 0;
    if (acc.getupLostS > 0.3 || (tau > ref.move.duration && up < 0.5)) {
      acc.fell = true;
      acc.fellTau = tau;
      return;
    }
  }
  if (tau < acc.fromTau - 1e-9) return;
  const sw = tau > acc.lookaheadTau ? 0.5 : 1;
  const s = sample(ref.move, Math.min(tau, ref.move.duration), { speed: 1, loop: false }, acc.s);
  // Pose.
  let pose = 0;
  for (let i = 0; i < r.joints.length; i++) {
    const c = w.joints[i].lib;
    if (c < 0) continue;
    const e = (qpos[r.joints[i].qadr] - s.q[c]) / 0.1;
    pose += ref.poseW[i] * e * e;
  }
  acc.sums.pose += sw * Math.min(CAP, pose) * acc.poseScale;
  // Root: pelvis position and attitude.
  const pe = [0, 1, 2].map((k) => xp[ids.pelvis * 3 + k] - refAt(ref.pelvis, 3, ref, tau, k));
  const rootPos = (pe[0] * pe[0] + pe[1] * pe[1] + pe[2] * pe[2]) / 0.0025;
  const rq = [0, 1, 2, 3].map((k) => refAt(ref.pelvisQuat, 4, ref, tau, k));
  const xq = d.xquat as Float64Array;
  const dotq = Math.abs(rq[0] * xq[ids.pelvis * 4] + rq[1] * xq[ids.pelvis * 4 + 1] + rq[2] * xq[ids.pelvis * 4 + 2] + rq[3] * xq[ids.pelvis * 4 + 3]) / Math.hypot(rq[0], rq[1], rq[2], rq[3]);
  const ang = 2 * Math.acos(Math.min(1, dotq));
  acc.sums.root += sw * Math.min(CAP, rootPos + 0.5 * (ang / 0.1) ** 2);
  // COM (get-ups: the height profile is the task, counted double).
  const ce = [0, 1, 2].map((k) => sc[ids.root * 3 + k] - refAt(ref.com, 3, ref, tau, k));
  acc.sums.com += sw * Math.min(CAP, (ce[0] * ce[0] + ce[1] * ce[1]) / 0.0025 + (getup ? 3 : 1) * (ce[2] * ce[2]) / 0.0025);
  // Torso attitude against the clip's (the lean the eye reads first; pelvis and joints can each be close
  // while the trunk pitches 30° off): angle between the up-axes, per 0.15 rad.
  {
    const tc = Math.min(tau, ref.move.duration);
    const rx = refAt(ref.torsoUp, 3, ref, tc, 0), ry = refAt(ref.torsoUp, 3, ref, tc, 1), rz = refAt(ref.torsoUp, 3, ref, tc, 2);
    const ux = xm[ids.torso * 9 + 2], uy = xm[ids.torso * 9 + 5];
    const cosA = Math.max(-1, Math.min(1, (ux * rx + uy * ry + up * rz) / Math.max(1e-9, Math.hypot(rx, ry, rz))));
    acc.sums.tilt += sw * Math.min(CAP, (Math.acos(cosA) / 0.15) ** 2);
  }
  // Heading against the clip's (a tornado that stops at −135° of −496° is a different move; the root
  // term's cap hid it): wrapped difference of the pelvis's lateral-axis heading, per 0.3 rad.
  {
    const hs = Math.atan2(-xm[ids.pelvis * 9 + 1], xm[ids.pelvis * 9 + 4]);
    const hr = refAt(ref.heading, 1, ref, Math.min(tau, ref.move.duration), 0) + ref.place.yaw;
    const e = Math.atan2(Math.sin(hs - hr), Math.cos(hs - hr));
    acc.sums.heading += sw * Math.min(CAP, (e / 0.3) ** 2);
  }
  // End effectors: planted soles; get-ups also hands and knees down; strikes the striker in the strike phase.
  let ee = 0;
  for (let f = 0; f < 2; f++) {
    if (!(clipBits & FOOT_BITS[f])) continue;
    let e2 = 0;
    for (let k = 0; k < 3; k++) {
      const e = sense.foot[f * 3 + k] - refAt(ref.sole, 6, ref, tau, f * 3 + k);
      e2 += e * e;
    }
    ee += e2 / 0.0025;
  }
  if (getup) {
    for (let f = 0; f < 2; f++) {
      if (clipBits & HAND_BITS[f]) {
        let e2 = 0;
        for (let k = 0; k < 3; k++) {
          const e = xp[ids.fist[f] * 3 + k] - refAt(ref.fist, 6, ref, tau, f * 3 + k);
          e2 += e * e;
        }
        ee += e2 / 0.0064;
      }
      if (clipBits & KNEE_BITS[f]) {
        let e2 = 0;
        for (let k = 0; k < 3; k++) {
          const e = xp[ids.shin[f] * 3 + k] - refAt(ref.knee, 6, ref, tau, f * 3 + k);
          e2 += e * e;
        }
        ee += e2 / 0.0064;
      }
    }
  } else if (ref.striker && tau >= ref.move.phases.strike && tau <= ref.move.phases.recover) {
    let e2 = 0;
    for (let k = 0; k < 3; k++) {
      const e = xp[ref.strikerBody * 3 + k] - refAt(ref.striker, 3, ref, tau, k);
      e2 += e * e;
    }
    ee += e2 / 0.0025;
  }
  acc.sums.ee += sw * Math.min(CAP, ee);
  // Foot slip and contact timing.
  const tol = getup ? 0.06 : 0.03;
  let slip = 0, mism = 0;
  soleCorners(w, cornersNow);
  for (let f = 0; f < 2; f++) {
    const planned = (clipBits & FOOT_BITS[f]) !== 0;
    const down = sense.footDown[f] === 1;
    if (planned && down && acc.hasPrev) {
      // The lowest corner (the one bearing load) moving over the canvas is a slip; pivoting about it is not.
      let lo = 0;
      for (let c = 1; c < 4; c++) if (cornersNow[f * 12 + c * 3 + 2] < cornersNow[f * 12 + lo * 3 + 2]) lo = c;
      const o2 = f * 12 + lo * 3;
      const vx = (cornersNow[o2] - acc.prevCorners[o2]) / dtS, vy = (cornersNow[o2 + 1] - acc.prevCorners[o2 + 1]) / dtS;
      slip += (vx * vx + vy * vy) / 0.01;
    }
    if (planned !== down) acc.mismatch[f] += dtS;
    else acc.mismatch[f] = 0;
    if (acc.mismatch[f] > tol) mism += 1;
  }
  acc.sums.slip += sw * Math.min(CAP, slip);
  acc.sums.contacts += sw * mism;
  // Balance margin of the DCM over the soles that are down (when the clip stands on feet only).
  const feetOnly = (clipBits & ~(CONTACT.FOOT_L | CONTACT.FOOT_R)) === 0 && (clipBits & (CONTACT.FOOT_L | CONTACT.FOOT_R)) !== 0;
  if (feetOnly && (sense.footDown[0] || sense.footDown[1])) {
    const omega0 = Math.sqrt(9.81 / Math.max(0.3, sense.com[2]));
    const xi = [sense.com[0] + sense.comVel[0] / omega0, sense.com[1] + sense.comVel[1] / omega0];
    const margin = supportMargin(w, xi);
    if (margin < 0.02) acc.sums.balance += sw * Math.min(CAP, ((0.02 - margin) / 0.02) ** 2);
  }
  // Buzz: torso angular rate above ~3 Hz.
  const wv = [cvel[ids.torso * 6], cvel[ids.torso * 6 + 1], cvel[ids.torso * 6 + 2]];
  if (!acc.hasLp) {
    acc.lp.set(wv);
    acc.hasLp = true;
  }
  const a = dtS / (0.053 + dtS);
  let hp2 = 0;
  for (let k = 0; k < 3; k++) {
    acc.lp[k] += (wv[k] - acc.lp[k]) * a;
    const h = wv[k] - acc.lp[k];
    hp2 += h * h;
  }
  acc.sums.buzz += sw * Math.min(CAP, hp2 / 0.01);
  // Headroom of the planted legs' servos, effort.
  const af = d.actuator_force as Float64Array;
  let head = 0, effort = 0;
  for (let i = 0; i < r.joints.length; i++) {
    const j = r.joints[i];
    const tau2 = Math.abs(af[j.act]);
    const u = tau2 / j.motor.stallTorqueNm;
    effort += u * u;
    const side = w.joints[i].side;
    const isLeg = /^(hip|knee|ankle)/.test(j.name);
    if (isLeg && side && sense.footDown[side === 'l' ? 0 : 1]) {
      const h = tau2 / Math.max(1e-6, j.availableTorque) - 0.85;
      if (h > 0) head += (h / 0.15) ** 2;
    }
  }
  acc.sums.headroom += sw * head;
  acc.sums.effort += sw * effort / r.joints.length;
  if (w.gyro) {
    const g = w.gyro.saturation - 0.5;
    if (g > 0) acc.sums.gyro += sw * (g / 0.5) ** 2;
  }
  acc.weight += sw;
  // Impact (once, when this run crosses the impact frame): the striker where the clip has it at the
  // impact frame (the robot's own kinematics), as fast as the clip's peak at the played rate.
  const m = ref.move;
  if (!acc.impactDone && ref.striker && m.impact !== null && tau >= m.impact && acc.hasPrev && acc.prevTau < m.impact) {
    acc.impactDone = true;
    const tw = [0, 1, 2].map((k) => refAt(ref.striker!, 3, ref, m.impact!, k));
    const p = [0, 1, 2].map((k) => xp[ref.strikerBody * 3 + k]);
    const err = Math.hypot(p[0] - tw[0], p[1] - tw[1], p[2] - tw[2]);
    const v = Math.hypot(p[0] - acc.prevStriker[0], p[1] - acc.prevStriker[1], p[2] - acc.prevStriker[2]) / dtS;
    acc.impactErr = err;
    acc.impactSpeed = v;
    // Speed against the actor's own peak (not × the played rate: a slowed strike is a soft one; the
    // first PoC run scored a head kick landing at 0.28× the clip's peak as on speed).
    const want = Math.max(0.5, m.peakSpeed * Math.max(1, pl.rate));
    acc.impact = WEIGHTS.impact * (Math.min(CAP, (err / 0.05) ** 2) * 0.5 - Math.min(v / want, 1.2));
  }
  // Terminal (once, at the end of the tail): stable, ready.
  if (!acc.terminalDone && tau >= acc.endTau - 1e-9 && tau >= pl.endTau - 1e-9) {
    acc.terminalDone = true;
    const omega0 = Math.sqrt(9.81 / Math.max(0.3, sense.com[2]));
    const xi = [sense.com[0] + sense.comVel[0] / omega0, sense.com[1] + sense.comVel[1] / omega0];
    const margin = sense.footDown[0] || sense.footDown[1] ? supportMargin(w, xi) : -0.2;
    const v = Math.hypot(sense.comVel[0], sense.comVel[1]);
    const om = Math.hypot(wv[0], wv[1]);
    const upErr = Math.max(0, 1 - xm[ids.torso * 9 + 8] / Math.max(0.5, refAt(ref.torsoUp, 3, ref, ref.move.duration, 2)));
    // Ends where the clip ends (a strike that leaves the fighter 15 cm forward is a lunge, not a punch).
    const ex = xp[ids.pelvis * 3] - refAt(ref.pelvis, 3, ref, ref.move.duration, 0), ey = xp[ids.pelvis * 3 + 1] - refAt(ref.pelvis, 3, ref, ref.move.duration, 1);
    acc.terminal = WEIGHTS.terminal * (Math.min(CAP, (Math.max(0, 0.02 - margin) / 0.02) ** 2) + Math.min(CAP, (Math.max(0, v - 0.1) / 0.2) ** 2)
      + Math.min(CAP, (Math.max(0, om - 0.1) / 0.2) ** 2) + Math.min(CAP, (upErr / 0.05) ** 2) + Math.min(CAP, (ex * ex + ey * ey) / 0.0025));
  }
}

const cornersNow = new Float64Array(24);

/** The four bottom corners of each sole box (world), 3 values each, left foot then right. */
export function soleCorners(w: PolishWorld, out: Float64Array): Float64Array {
  const d = w.ctx.data;
  const gx = d.geom_xpos as Float64Array, gm = d.geom_xmat as Float64Array;
  const [hx, hy, hz] = w.footHalf;
  for (let f = 0; f < 2; f++) {
    const g = w.ids.footGeom[f];
    const o = g * 9;
    let c = 0;
    for (const [ax, ay] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
      for (let k = 0; k < 3; k++) out[f * 12 + c * 3 + k] = gx[g * 3 + k] + gm[o + k * 3] * ax + gm[o + k * 3 + 1] * ay - gm[o + k * 3 + 2] * hz;
      c++;
    }
  }
  return out;
}

/** Signed margin of a point inside the support of the soles that are down (+ inside, − outside), m. */
export function supportMargin(w: PolishWorld, p: number[]): number {
  const d = w.ctx.data;
  const gx = d.geom_xpos as Float64Array, gm = d.geom_xmat as Float64Array;
  const pts: Array<[number, number]> = [];
  const [hx, hy] = w.footHalf;
  for (let f = 0; f < 2; f++) {
    if (!w.sense.footDown[f]) continue;
    const g = w.ids.footGeom[f];
    const o = g * 9;
    for (const [ax, ay] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
      pts.push([gx[g * 3] + gm[o] * ax + gm[o + 1] * ay, gx[g * 3 + 1] + gm[o + 3] * ax + gm[o + 4] * ay]);
    }
  }
  if (pts.length < 3) return -0.2;
  const hull = hull2(pts);
  let inside = true, best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1e-12;
    if (ex * (p[1] - a[1]) - ey * (p[0] - a[0]) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + ex * t), p[1] - (a[1] + ey * t)));
  }
  return inside ? best : -best;
}

function hull2(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossZ = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// ---------------------------------------------------------------- dense trace (measurement, viewer)

export const TRACE_FIELDS = 72; // per sample, see traceSample
export interface Trace {
  n: number;
  data: Float64Array; // grows
  push(row: ArrayLike<number>): void;
}
export function newTrace(cap = 2048): Trace {
  const t: Trace = {
    n: 0,
    data: new Float64Array(cap * TRACE_STRIDE),
    push(row) {
      if ((t.n + 1) * TRACE_STRIDE > t.data.length) {
        const nd = new Float64Array(t.data.length * 2);
        nd.set(t.data);
        t.data = nd;
      }
      t.data.set(row, t.n * TRACE_STRIDE);
      t.n++;
    },
  };
  return t;
}

/**
 * Trace row layout (every 10 ms): 0 wall, 1 tau, 2 rate, 3-9 root qpos (x y z qw qx qy qz),
 * 10-32 joints (23, robot order), 33-35 COM, 36-38 COM vel, 39-44 soles, 45-46 foot down, 47-49 striker,
 * 50-52 torso ω, 53 torso up z, 54 gyro saturation, 55 max |τ|/τ_stall, 56 max |ω|/ω_noload,
 * 57 max planted-leg |τ|/τ_avail, 58 max winding °C, 59 battery, 60 fallen flag,
 * 61-63 lowest corner of the left sole (x y z), 64-66 of the right sole, 67-69 pelvis (x y z), 70 COM-over-support... spare, 71 spare.
 */
export const TRACE_STRIDE = 72;
const row = new Float64Array(TRACE_STRIDE);
const traceCorners = new Float64Array(24);

function traceSample(w: PolishWorld, pl: PolishedPlayer, ref: Reference | null, t: Trace, wall: number, fallen: number): void {
  const d = w.ctx.data;
  const qpos = d.qpos as Float64Array, qvel = d.qvel as Float64Array, xp = d.xpos as Float64Array, xm = d.xmat as Float64Array, cvel = d.cvel as Float64Array;
  const af = d.actuator_force as Float64Array;
  const r = w.r, s = w.sense, ids = w.ids;
  row.fill(0);
  row[0] = wall;
  row[1] = pl.tau;
  row[2] = pl.rate;
  for (let k = 0; k < 7; k++) row[3 + k] = qpos[r.rootQadr + k];
  for (let i = 0; i < r.joints.length && i < 23; i++) row[10 + i] = qpos[r.joints[i].qadr];
  for (let k = 0; k < 3; k++) {
    row[33 + k] = s.com[k];
    row[36 + k] = s.comVel[k];
    row[39 + k] = s.foot[k];
    row[42 + k] = s.foot[3 + k];
    if (ref && ref.strikerBody >= 0) row[47 + k] = xp[ref.strikerBody * 3 + k];
    row[50 + k] = cvel[ids.torso * 6 + k];
  }
  row[45] = s.footDown[0];
  row[46] = s.footDown[1];
  row[53] = xm[ids.torso * 9 + 8];
  row[54] = w.gyro?.saturation ?? 0;
  let mt = 0, mw = 0, ml = 0, temp = 0;
  for (let i = 0; i < r.joints.length; i++) {
    const j = r.joints[i];
    const tq = Math.abs(af[j.act]);
    mt = Math.max(mt, tq / j.motor.stallTorqueNm);
    mw = Math.max(mw, Math.abs(qvel[j.dadr]) / j.motor.noLoadSpeedRadS);
    const side = w.joints[i].side;
    if (/^(hip|knee|ankle)/.test(j.name) && side && s.footDown[side === 'l' ? 0 : 1]) ml = Math.max(ml, tq / Math.max(1e-6, j.availableTorque));
    temp = Math.max(temp, j.tempC);
  }
  row[55] = mt;
  row[56] = mw;
  row[57] = ml;
  row[58] = temp;
  row[59] = r.battery;
  row[60] = fallen;
  soleCorners(w, traceCorners);
  for (let f = 0; f < 2; f++) {
    let lo = 0;
    for (let c = 1; c < 4; c++) if (traceCorners[f * 12 + c * 3 + 2] < traceCorners[f * 12 + lo * 3 + 2]) lo = c;
    for (let k = 0; k < 3; k++) row[61 + f * 3 + k] = traceCorners[f * 12 + lo * 3 + k];
  }
  for (let k = 0; k < 3; k++) row[67 + k] = s.pelvis[k];
  t.push(row);
}

// ---------------------------------------------------------------- the loop

export interface RunOpts {
  /** Stop once the clock reaches this clip time (and at a control tick). Infinity: run to the end of the tail. */
  untilTau: number;
  /** Hard cap on wall seconds simulated in this call. */
  maxWallS: number;
  feedback: boolean;
  cost?: CostAcc | null;
  /** Record the nominal: samples written at index ticks/2 (the player's clock). */
  nominal?: Float64Array | null;
  /** Dense trace every 10 ms. */
  trace?: Trace | null;
  /** Take a snapshot at the first control tick whose clock is at or past this clip time. */
  snapAtTau?: number | null;
  perturb?: Perturb;
  /** Stop when the cost says the robot fell (optimisation); measurement keeps going. */
  stopOnFall?: boolean;
  /** Called every control tick after the targets are set (diagnostics). */
  onTick?: () => void;
}

export interface RunResult {
  snap: Snapshot | null;
  /** Player clock state at the snapshot. */
  snapPlayer: { tau: number; rate: number; ticks: number } | null;
  fell: boolean;
  wallS: number;
  steps: number;
}

/**
 * Run the move from the current world state and player clock. The caller restores the snapshot and
 * the player's clock before calling. Control runs on even physics ticks, as the game's control system.
 */
export function run(w: PolishWorld, pl: PolishedPlayer, ref: Reference | null, o: RunOpts): RunResult {
  const { ctx, r } = w;
  const xfrc = () => ctx.data.xfrc_applied as Float64Array;
  pl.feedback = o.feedback;
  const lat = o.perturb?.latencyTicks ?? 0;
  const ring = lat > 0 ? Array.from({ length: lat + 1 }, () => new Float64Array(r.joints.length)) : null;
  let ringI = 0, ringFill = 0;
  const push = o.perturb?.push;
  let pushOn = false;
  let snap: Snapshot | null = null, snapPlayer: RunResult['snapPlayer'] = null;
  const torsoBody = w.ids.torso;
  const startTick = ctx.tick;
  const maxSteps = Math.round(o.maxWallS / ctx.dt);
  let steps = 0;
  let fallen = 0;
  const acc = o.cost ?? null;
  while (steps < maxSteps) {
    if (ctx.tick % STEPS_PER_TICK === 0) {
      if (pl.tau >= o.untilTau - 1e-12) break;
      if (o.snapAtTau !== undefined && o.snapAtTau !== null && !snap && pl.tau >= o.snapAtTau - 1e-12) {
        snap = snapshot(w);
        snapPlayer = { tau: pl.tau, rate: pl.rate, ticks: pl.ticks };
      }
      const sense = readSense(w);
      const tg = pl.tick(CONTROL_DT, sense);
      if (ring) {
        ring[ringI].set(tg);
        ringFill = Math.min(ringFill + 1, ring.length);
        const k = ringFill <= lat ? (ringI - ringFill + 1 + ring.length) % ring.length : (ringI - lat + ring.length) % ring.length;
        r.targets.set(ring[k]);
        ringI = (ringI + 1) % ring.length;
      } else r.targets.set(tg);
      if (w.gyro) w.gyro.update(r, sense.torsoRot as unknown as Mat3, [pl.gyro[0], pl.gyro[1], pl.gyro[2]], CONTROL_DT, xfrc(), torsoBody, true);
      if (o.nominal && pl.ticks % TICKS_PER_NOMINAL === 0) recordNominal(w, pl, o.nominal);
      o.onTick?.();
    }
    if (push) {
      const t = pl.wall;
      const want = t >= push.t && t < push.t + push.dur;
      if (want !== pushOn) {
        const xf = xfrc();
        const sgn = want ? 1 : -1;
        xf[torsoBody * 6] += sgn * push.fx;
        xf[torsoBody * 6 + 1] += sgn * push.fy;
        pushOn = want;
      }
    }
    physicsStep(w);
    steps++;
    if ((ctx.tick - startTick) % SAMPLE_STEPS === 0) {
      if (acc && !acc.fell) {
        costSample(w, pl, acc);
        // finite-difference state for the next sample
        for (let k = 0; k < 6; k++) acc.prevSole[k] = w.sense.foot[k];
        if (ref && ref.strikerBody >= 0) {
          const xp = ctx.data.xpos as Float64Array;
          for (let k = 0; k < 3; k++) acc.prevStriker[k] = xp[ref.strikerBody * 3 + k];
        }
        acc.prevTau = pl.tau;
        soleCorners(w, acc.prevCorners);
        acc.hasPrev = true;
        if (acc.fell && o.stopOnFall) break;
      }
      if (o.trace) {
        const up = (ctx.data.xmat as Float64Array)[torsoBody * 9 + 8];
        if (up < 0.5) fallen = 1;
        traceSample(w, pl, ref, o.trace, pl.wall, fallen);
      }
    }
    if (!Number.isFinite((ctx.data.qvel as Float64Array)[r.rootDadr])) {
      if (acc) {
        acc.fell = true;
        acc.fellTau = pl.tau;
      }
      break;
    }
  }
  // The clock may reach the end between two samples: score the end state (terminal cost) now.
  if (acc && !acc.fell && !acc.terminalDone && pl.tau >= pl.endTau - 1e-9 && pl.tau >= acc.endTau - 1e-9) costSample(w, pl, acc);
  if (pushOn && push) {
    const xf = xfrc();
    xf[torsoBody * 6] -= push.fx;
    xf[torsoBody * 6 + 1] -= push.fy;
  }
  return { snap, snapPlayer, fell: acc?.fell ?? false, wallS: steps * ctx.dt, steps };
}

/** Write the nominal channels (orthodox move frame) at the player's current clock. */
export function recordNominal(w: PolishWorld, pl: PolishedPlayer, out: Float64Array): void {
  const idx = pl.ticks / TICKS_PER_NOMINAL;
  const o = idx * NOMINAL_STRIDE;
  if (o + NOMINAL_STRIDE > out.length) return;
  const s = w.sense;
  const c = Math.cos(pl.place.yaw), sn = Math.sin(pl.place.yaw);
  const my = pl.mirror ? -1 : 1;
  const mx = (x: number, y: number) => c * x + sn * y;
  const myf = (x: number, y: number) => (-sn * x + c * y) * my;
  const cx = s.com[0] - pl.place.x, cy = s.com[1] - pl.place.y;
  out[o] = mx(cx, cy);
  out[o + 1] = myf(cx, cy);
  out[o + 2] = s.com[2];
  out[o + 3] = mx(s.comVel[0], s.comVel[1]);
  out[o + 4] = myf(s.comVel[0], s.comVel[1]);
  out[o + 5] = s.comVel[2];
  // L: pseudovector — rotate, then mirror flips x and z.
  const lx = mx(s.L[0], s.L[1]), ly = -sn * s.L[0] + c * s.L[1];
  out[o + 6] = pl.mirror ? -lx : lx;
  out[o + 7] = ly;
  out[o + 8] = pl.mirror ? -s.L[2] : s.L[2];
  // Torso attitude quaternion in the move frame (from the rotation matrix).
  const R = s.torsoRot;
  // M = Rz(−yaw)·R
  const m = [
    c * R[0] + sn * R[3], c * R[1] + sn * R[4], c * R[2] + sn * R[5],
    -sn * R[0] + c * R[3], -sn * R[1] + c * R[4], -sn * R[2] + c * R[5],
    R[6], R[7], R[8],
  ];
  const q = matQuat(m);
  // Keep the quaternion's sign continuous so the player's linear interpolation never passes through 0.
  if (idx > 0) {
    const p = o - NOMINAL_STRIDE;
    const dq = out[p + 9] * q[0] + out[p + 10] * (pl.mirror ? -q[1] : q[1]) + out[p + 11] * q[2] + out[p + 12] * (pl.mirror ? -q[3] : q[3]);
    if (dq < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];
  }
  out[o + 9] = q[0];
  out[o + 10] = pl.mirror ? -q[1] : q[1];
  out[o + 11] = q[2];
  out[o + 12] = pl.mirror ? -q[3] : q[3];
  const px = s.pelvis[0] - pl.place.x, py = s.pelvis[1] - pl.place.y;
  out[o + 13] = mx(px, py);
  out[o + 14] = myf(px, py);
  out[o + 15] = s.pelvis[2];
  // Support centre of the soles that are down (else the COM's ground point).
  const nd = s.footDown[0] + s.footDown[1];
  let sx = s.com[0], sy = s.com[1];
  if (nd > 0) {
    sx = 0;
    sy = 0;
    for (let f = 0; f < 2; f++) if (s.footDown[f]) {
      sx += s.foot[f * 3];
      sy += s.foot[f * 3 + 1];
    }
    sx /= nd;
    sy /= nd;
  }
  out[o + 16] = mx(sx - pl.place.x, sy - pl.place.y);
  out[o + 17] = myf(sx - pl.place.x, sy - pl.place.y);
  // The clock's first sample is taken at its second tick: sample 0 repeats it.
  if (idx === 1) for (let c = 0; c < NOMINAL_STRIDE; c++) out[c] = out[NOMINAL_STRIDE + c];
}

function matQuat(m: number[]): [number, number, number, number] {
  const tr = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  return [w, x, y, z];
}
