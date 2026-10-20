// PolishedPlayer: plays a polished move (docs/design/move-polish.md §5.2) at control rate. The offline
// optimiser (tools/polish) rolls out this very file, so what it stores is what the game replays.
//   clock      τ advances at the stored per-frame clip rate (nearest 60 Hz frame, as MotionPlayer);
//              past the clip's end the last frame is held through the settle tail at 1×
//   targets    q = sample(move, τ).q + Δq(τ), Δq a cubic B-spline (C2) in clip time; southpaw
//              mirrors both through the library's joint mirror map
//   feed-fwd   the servo's damping is moved onto the tracking error: the target shifts by
//              kd·q̇/kp (q̇ = (clip slope + spline slope) × rate, capped at no-load speed, the shift at
//              ±0.35 rad), the same arithmetic as the tracker's velocity feed-forward
//   feedback   reference-relative to the SIMULATED NOMINAL (a trajectory the robot really made), and
//              only on the part of each error beyond its dead band, so the nominal replay gets none:
//                stance ankles   pitch/roll turn the body over the foot to pull the COM (over the
//                                support) and its velocity back to the nominal
//                stance hips     the same form, plus the torso's tilt error
//                gyro            stored feed-forward + k_L·(L̂ − L), pitch and roll (the GyroCore caps it)
//              each joint's feedback clamped to ±fb.clamp
// The player never touches forces: it returns servo targets and a gyro torque demand, and the caller
// pushes them through the game's own motor model and GyroCore. No allocation per tick.
import { newSample, sample } from '../sampler';
import type { MirrorMap, MotionSample, Move } from '../types';
import { MAX_COP_SHIFT_M, NOMINAL_HZ, NOMINAL_STRIDE, TRACK_STRIDE, ZERO_FEEDBACK, type DeadBands, type FeedbackGains } from './format';
import { knotValue, newSplineEval, splineBasis, splineSlope, splineValue, type SplineEval } from './spline';

const MIN_RATE = 0.05;
const FEET = 3; // CONTACT.FOOT_L | CONTACT.FOOT_R
const MAX_VEL_SHIFT_RAD = 0.35;
/** Control period the stored rollouts used (500 Hz, every 2nd 1 ms physics step). */
export const CONTROL_DT = 0.002;

export type FeedbackRole = 'anklePitch' | 'ankleRoll' | 'hipPitch' | 'hipRoll' | null;

export interface PlayerJoint {
  /** Library channel of this robot joint (−1: the clip has none; the joint holds 0 + Δq). */
  lib: number;
  noLoad: number; // rad/s
  side: 'l' | 'r' | null;
  role: FeedbackRole;
}

/** What the caller measures each control tick (world frame), allocated once. */
export interface BodySense {
  com: Float64Array; // 3
  comVel: Float64Array; // 3
  L: Float64Array; // 3, angular momentum about the COM
  torsoRot: Float64Array; // 9, row-major (world = R · local)
  pelvis: Float64Array; // 3
  foot: Float64Array; // 6: left sole centre, right sole centre
  footDown: Uint8Array; // 2
  axis: Float64Array; // 3 per robot joint: the joint axis in the world
  kp: Float64Array; // effective servo stiffness per robot joint (0: limp)
  kd: Float64Array; // effective servo damping per robot joint
  mass: number; // whole robot, kg
}

export function newBodySense(nj: number): BodySense {
  return {
    com: new Float64Array(3), comVel: new Float64Array(3), L: new Float64Array(3), torsoRot: new Float64Array(9),
    pelvis: new Float64Array(3), foot: new Float64Array(6), footDown: new Uint8Array(2), axis: new Float64Array(nj * 3),
    kp: new Float64Array(nj), kd: new Float64Array(nj), mass: 0,
  };
}

/** Everything the player needs about one move's polish (decoded file, or an optimiser candidate). */
export interface PolishPlan {
  knotS: number;
  segments: number; // spline segments covering the move and its tail
  tailS: number;
  rates: ArrayLike<number>; // clip rate per 60 Hz clip frame, move + tail
  dq: ArrayLike<number>; // (segments + 3) × libJoints
  libJoints: number;
  gyroFF: ArrayLike<number> | null; // (segments + 1) × 2, torso-local roll/pitch N·m
  fb: FeedbackGains;
  deadband: DeadBands;
  nominal: ArrayLike<number> | null; // samples × NOMINAL_STRIDE (orthodox move frame)
  nominalSamples: number;
  /** Feedback reference per clip frame: COM xyz, torso up xyz (orthodox move frame); null: no feedback. */
  track: ArrayLike<number> | null;
  trackFrames: number;
}

export interface Placement {
  x: number;
  y: number;
  yaw: number;
}

const ZERO_BANDS: DeadBands = { com: 0, comVel: 0, L: 0, tilt: 0 };

/** A plan that plays the clip plainly: zero Δq, no feedback, the given per-frame rates. */
export function plainPlan(rates: ArrayLike<number>, libJoints: number, knotS: number, segments: number, tailS: number): PolishPlan {
  return {
    knotS, segments, tailS, rates, dq: new Float64Array((segments + 3) * libJoints), libJoints, gyroFF: null,
    fb: ZERO_FEEDBACK, deadband: ZERO_BANDS, nominal: null, nominalSamples: 0, track: null, trackFrames: 0,
  };
}

export class PolishedPlayer {
  plan: PolishPlan;
  move: Move;
  mirror = false;
  place: Placement = { x: 0, y: 0, yaw: 0 };
  /** Clip time, s at 1× (runs past move.duration through the tail). */
  tau = 0;
  /** Clip seconds per wall second at the last tick. */
  rate = 0;
  /** Control ticks since the clock started. */
  ticks = 0;
  /** Feedback on/off (the optimiser's nominal rollouts run it off; with it on they are identical). */
  feedback = true;
  readonly targets: Float64Array;
  /** Gyro torque demand, world frame (N·m). */
  readonly gyro: Float64Array = new Float64Array(3);
  /** Feedback added this tick per robot joint (rad), for logs and tests. */
  readonly fbOut: Float64Array;
  /** Commanded joint velocity per robot joint (rad/s) at the last tick. */
  readonly qdCmd: Float64Array;
  private readonly s: MotionSample;
  private readonly e: SplineEval = newSplineEval();
  private readonly dqLib: Float64Array;
  private readonly dqdLib: Float64Array;
  private readonly nomA = new Float64Array(NOMINAL_STRIDE);

  constructor(readonly joints: readonly PlayerJoint[], readonly mirrorMap: MirrorMap, move: Move, plan: PolishPlan) {
    this.move = move;
    this.plan = plan;
    this.s = newSample(plan.libJoints);
    this.targets = new Float64Array(joints.length);
    this.fbOut = new Float64Array(joints.length);
    this.qdCmd = new Float64Array(joints.length);
    this.dqLib = new Float64Array(plan.libJoints);
    this.dqdLib = new Float64Array(plan.libJoints);
  }

  /** Total clip time the clock runs (move plus tail). */
  get endTau(): number {
    return this.move.duration + this.plan.tailS;
  }

  get done(): boolean {
    return this.tau >= this.endTau - 1e-9;
  }

  /** Wall seconds since the clock started. */
  get wall(): number {
    return this.ticks * CONTROL_DT;
  }

  start(place: Placement, mirror = false): void {
    this.place = place;
    this.mirror = mirror;
    this.tau = 0;
    this.rate = 0;
    this.ticks = 0;
  }

  /** Clip rate at clip time tau: the stored rate of the nearest 60 Hz frame (1× in the tail past the table). */
  rateAt(tau: number): number {
    const r = this.plan.rates;
    const f = Math.round(tau * this.move.fps);
    if (f >= r.length) return 1;
    return r[Math.max(0, f)];
  }

  /**
   * Hold the move's first frame (with its correction) and no feed-forward: the settle before the
   * clock starts.
   */
  hold(): Float64Array {
    this.evaluate(0, 0);
    this.fbOut.fill(0);
    this.gyro.fill(0);
    return this.targets;
  }

  /** One control tick: advance the clock by dt wall seconds, then targets and gyro demand. */
  tick(dt: number, sense: BodySense): Float64Array {
    this.rate = Math.max(MIN_RATE, this.rateAt(this.tau));
    this.tau = Math.min(this.endTau, this.tau + dt * this.rate);
    this.ticks++;
    this.evaluate(this.tau, this.rate);
    // Velocity feed-forward (the tracker's arithmetic): kd·q̇/kp with the damping and gain in force.
    for (let i = 0; i < this.joints.length; i++) {
      const kp = sense.kp[i];
      if (kp <= 0) continue;
      const lim = this.joints[i].noLoad;
      const v = Math.max(-lim, Math.min(lim, this.qdCmd[i]));
      this.targets[i] += Math.max(-MAX_VEL_SHIFT_RAD, Math.min(MAX_VEL_SHIFT_RAD, (sense.kd[i] * v) / kp));
    }
    this.fbOut.fill(0);
    this.gyro.fill(0);
    this.gyroFeedForward(sense);
    // The feedback is a standing-balance law: it runs only while the clip stands on its feet alone
    // (not lying, kneeling or on the hands in a get-up, not airborne in a jump).
    const c = this.s.contacts;
    const standing = (c & FEET) !== 0 && (c & ~FEET) === 0;
    if (this.feedback && standing && this.plan.track && this.plan.trackFrames > 1) this.applyFeedback(sense);
    return this.targets;
  }

  /** Clip pose + spline correction at tau (targets, and the commanded velocity at `rate`). */
  private evaluate(tau: number, rate: number): void {
    const m = this.move, p = this.plan, nl = p.libJoints;
    const inClip = tau < m.duration;
    sample(m, Math.min(tau, m.duration), { speed: 1, mirror: this.mirror, loop: false }, this.s);
    splineBasis(tau, p.knotS, p.segments, this.e);
    const perm = this.mirrorMap.perm, sign = this.mirrorMap.sign;
    for (let c = 0; c < nl; c++) {
      const src = this.mirror ? perm[c] : c;
      const sg = this.mirror ? sign[c] : 1;
      this.dqLib[c] = sg * splineValue(p.dq, nl, src, this.e);
      this.dqdLib[c] = sg * splineSlope(p.dq, nl, src, this.e);
    }
    for (let i = 0; i < this.joints.length; i++) {
      const c = this.joints[i].lib;
      if (c < 0) {
        this.targets[i] = 0;
        this.qdCmd[i] = 0;
        continue;
      }
      this.targets[i] = this.s.q[c] + this.dqLib[c];
      this.qdCmd[i] = ((inClip ? this.s.qd[c] : 0) + this.dqdLib[c]) * rate;
    }
  }

  private gyroFeedForward(sense: BodySense): void {
    const ff = this.plan.gyroFF;
    if (!ff) return;
    let tx = knotValue(ff, 2, 0, this.tau, this.plan.knotS);
    const ty = knotValue(ff, 2, 1, this.tau, this.plan.knotS);
    if (this.mirror) tx = -tx; // roll torque flips with the sagittal mirror, pitch keeps
    const R = sense.torsoRot;
    this.gyro[0] += R[0] * tx + R[1] * ty;
    this.gyro[1] += R[3] * tx + R[4] * ty;
    this.gyro[2] += R[6] * tx + R[7] * ty;
  }

  /** The nominal at the current wall time (linear between NOMINAL_HZ samples), orthodox move frame. */
  nominalNow(out: Float64Array = this.nomA): Float64Array {
    const nom = this.plan.nominal!;
    const n = this.plan.nominalSamples;
    const x = Math.min(n - 1, Math.max(0, this.wall * NOMINAL_HZ));
    const i = Math.min(n - 2, Math.floor(x)), w = x - i;
    for (let c = 0; c < NOMINAL_STRIDE; c++) out[c] = nom[i * NOMINAL_STRIDE + c] * (1 - w) + nom[(i + 1) * NOMINAL_STRIDE + c] * w;
    return out;
  }

  private readonly trk = new Float64Array(9);

  /**
   * The feedback reference at the current clock (orthodox move frame): COM (0-2), COM velocity at the
   * played rate (3-5, zero once the clip has ended), torso up-axis (6-8).
   */
  trackNow(): Float64Array {
    const t = this.plan.track!, n = this.plan.trackFrames, fps = this.move.fps;
    const tau = Math.min(this.tau, this.move.duration);
    const x = Math.max(0, Math.min(n - 1, tau * fps));
    const i = Math.min(n - 2, Math.floor(x)), w = x - i;
    const S = TRACK_STRIDE;
    for (let c = 0; c < 3; c++) {
      const a = t[i * S + c], b = t[(i + 1) * S + c];
      this.trk[c] = a + (b - a) * w;
      this.trk[3 + c] = this.tau < this.move.duration ? (b - a) * fps * this.rate : 0;
      this.trk[6 + c] = t[i * S + 3 + c] + (t[(i + 1) * S + 3 + c] - t[i * S + 3 + c]) * w;
    }
    return this.trk;
  }

  // World ↔ orthodox move frame. Positions: subtract the placement, rotate by −yaw, mirror y.
  private toMoveXY(wx: number, wy: number, out: [number, number]): [number, number] {
    const c = Math.cos(this.place.yaw), s = Math.sin(this.place.yaw);
    const dx = wx, dy = wy;
    out[0] = c * dx + s * dy;
    out[1] = (-s * dx + c * dy) * (this.mirror ? -1 : 1);
    return out;
  }

  private readonly t2a: [number, number] = [0, 0];
  private readonly t2b: [number, number] = [0, 0];

  private applyFeedback(sense: BodySense): void {
    const fb = this.plan.fb, db = this.plan.deadband;
    const tr = this.trackNow();
    const down = sense.footDown;
    const nDown = (down[0] ? 1 : 0) + (down[1] ? 1 : 0);
    const my = this.mirror ? -1 : 1;
    const c2 = Math.cos(this.place.yaw), s2 = Math.sin(this.place.yaw);
    const g = 9.81;
    // COM and COM-velocity errors against the nominal, move frame (orthodox), dead-banded.
    const c = this.toMoveXY(sense.com[0] - this.place.x, sense.com[1] - this.place.y, this.t2a);
    let ex = c[0] - tr[0], ey = c[1] - tr[1];
    const v = this.toMoveXY(sense.comVel[0], sense.comVel[1], this.t2a);
    let evx = v[0] - tr[3], evy = v[1] - tr[4];
    const em = Math.hypot(ex, ey);
    const ek = em > db.com ? 1 - db.com / em : 0;
    ex *= ek;
    ey *= ek;
    const vm = Math.hypot(evx, evy);
    const vk = vm > db.comVel ? 1 - db.comVel / vm : 0;
    evx *= vk;
    evy *= vk;
    let sz = 0;
    for (let k = 0; k < 2; k++) if (down[k]) sz += sense.foot[k * 3 + 2];
    const h = Math.max(0.3, sense.com[2] - (nDown ? sz / nDown : 0));
    const w0 = Math.sqrt(g / h);
    /** A move-frame vector (x, y) to the world. */
    const toWorld = (mx: number, myv: number, out: [number, number]): [number, number] => {
      const yy = myv * my;
      out[0] = c2 * mx - s2 * yy;
      out[1] = s2 * mx + c2 * yy;
      return out;
    };
    const mg = sense.mass * g;
    if (nDown > 0 && (fb.ankleD || fb.ankleV || fb.hipTilt)) {
      // Ankles: shift the centre of pressure toward the error (DCM-style), within the sole.
      let px = fb.ankleD * ex + (fb.ankleV * evx) / w0, py = fb.ankleD * ey + (fb.ankleV * evy) / w0;
      const pm = Math.hypot(px, py);
      if (pm > MAX_COP_SHIFT_M) {
        px *= MAX_COP_SHIFT_M / pm;
        py *= MAX_COP_SHIFT_M / pm;
      }
      const dp = toWorld(px, py, this.t2b);
      // Torque the joint must put on the foot: F·(ẑ × Δp), F the foot's share of the weight.
      const F = mg / nDown;
      const tax = -F * dp[1], tay = F * dp[0];
      // Hips: turn the torso back toward the nominal's attitude (rotation u × n̂, horizontal part).
      let rhX = 0, rhY = 0;
      if (fb.hipTilt) {
        const R = sense.torsoRot;
        const ux = R[2], uy = R[5], uz = R[8];
        const nx0 = tr[6], ny0 = tr[7] * my, nz = tr[8];
        const nx = c2 * nx0 - s2 * ny0, ny = s2 * nx0 + c2 * ny0;
        let tx = uy * nz - uz * ny, ty = uz * nx - ux * nz;
        const tm = Math.hypot(tx, ty);
        const tk = tm > db.tilt ? 1 - db.tilt / tm : 0;
        tx *= tk;
        ty *= tk;
        rhX = fb.hipTilt * tx;
        rhY = fb.hipTilt * ty;
      }
      const lim = fb.clamp;
      for (let i = 0; i < this.joints.length; i++) {
        const j = this.joints[i];
        if (!j.role || !j.side) continue;
        if (!down[j.side === 'l' ? 0 : 1]) continue;
        const kp = sense.kp[i];
        if (kp <= 0) continue;
        const ax = sense.axis[i * 3], ay = sense.axis[i * 3 + 1];
        let d: number;
        if (j.role === 'anklePitch' || j.role === 'ankleRoll') d = (tax * ax + tay * ay) / kp;
        else d = -(rhX * ax + rhY * ay); // the torso turns by ρ relative to the planted thigh
        d = Math.max(-lim, Math.min(lim, d));
        this.targets[i] += d;
        this.fbOut[i] = d;
      }
    }
    if (fb.gyroD || fb.gyroV || fb.gyroL) {
      // Gyro couple on the body: −m·g·(ẑ × Δp) moves the CMP by Δp; plus k_L·(L̂ − L).
      const gx = fb.gyroD * ex + (fb.gyroV * evx) / w0, gy = fb.gyroD * ey + (fb.gyroV * evy) / w0;
      const dp = toWorld(gx, gy, this.t2b);
      this.gyro[0] += mg * dp[1];
      this.gyro[1] += -mg * dp[0];
      if (fb.gyroL && this.plan.nominal && this.plan.nominalSamples > 1) {
        const n = this.nominalNow();
        let lx = n[6];
        const ly = n[7];
        if (this.mirror) lx = -lx;
        const wlx = c2 * lx - s2 * ly, wly = s2 * lx + c2 * ly;
        let lex = wlx - sense.L[0], ley = wly - sense.L[1];
        const m = Math.hypot(lex, ley);
        const k = m > db.L ? 1 - db.L / m : 0;
        lex *= k;
        ley *= k;
        this.gyro[0] += fb.gyroL * lex;
        this.gyro[1] += fb.gyroL * ley;
      }
    }
  }
}

/** Robot joint → player joint description (feedback roles from the joint names). */
export function playerJoints(names: readonly string[], libJoints: readonly string[], noLoad: ArrayLike<number>): PlayerJoint[] {
  return names.map((name, i) => {
    const m = /^(ankle_pitch|ankle_roll|hip_pitch|hip_roll)_([lr])$/.exec(name);
    const role: FeedbackRole = m ? (({ ankle_pitch: 'anklePitch', ankle_roll: 'ankleRoll', hip_pitch: 'hipPitch', hip_roll: 'hipRoll' } as const)[m[1] as 'ankle_pitch']) : null;
    const side = /_([lr])$/.exec(name)?.[1] as 'l' | 'r' | undefined;
    return { lib: libJoints.indexOf(name), noLoad: noLoad[i], side: side ?? null, role };
  });
}

