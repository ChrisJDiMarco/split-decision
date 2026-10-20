// What the optimiser may change (move-polish.md §2) and how a parameter vector maps onto it:
//   Δq      cubic B-spline control points every 0.1 s of clip time, |Δq| ≤ 0.4 rad
//   warp    log of a multiplier on today's MotionPlayer rate, per 0.1 s knot (rate within [0.05, 2.5])
//   gyroFF  torso roll/pitch torque per knot, |τ| ≤ τ_max (kicks and flashy moves only)
// Window k commits spline segments [2k, 2k+2): control points 2k+3 and 2k+4 (window 0 also 0..2),
// warp and gyro knots 2k+1 and 2k+2 (window 0 also knot 0).
import { mocapSet, type JointMask } from '../../src/physics/control/mocap/library';
import { MAX_RATE } from '../../src/physics/control/mocap/library';
import type { Move } from '../../src/robots/motions';
import { DEFAULT_FEEDBACK, TRACK_STRIDE, type DeadBands, type FeedbackGains } from '../../src/robots/motions/polish/format';
import type { PolishPlan } from '../../src/robots/motions/polish/player';
import { moveKind, type MoveKind } from './reference';
import type { PolishWorld } from './world';

export const KNOT_S = 0.1;
export const TAIL_S = 0.5;
export const SETTLE_S = 0.4;
export const DQ_MAX = 0.4;
export const WARP_MAX = 0.7; // e^0.7 ≈ 2× either way
export const LOOKAHEAD_S = 0.4;
export const DEFAULT_BANDS: DeadBands = { com: 0.002, comVel: 0.01, L: 0.5, tilt: 0.005 };

/** Today's playback pace per kind (the tracker's): wanted speed, rate-table mask, limit scale. */
export const TODAY: Record<MoveKind, { speed: number; mask: JointMask; limitScale: number; why: string }> = {
  punch: { speed: 1.8, mask: 'upper', limitScale: 1, why: 'mocap/strikes.ts PUNCH_SPEED, upper-body rate table' },
  kick: { speed: 1.6, mask: 'legs', limitScale: 0.6, why: 'mocap/strikes.ts KICK_SPEED × KICK_LIMIT_SCALE, leg rate table' },
  getup: { speed: 1.15, mask: 'all', limitScale: 1, why: 'mocap/getup.ts PACE, whole-body rate table' },
  flashy: { speed: 1.6, mask: 'legs', limitScale: 0.6, why: 'no flashy tracker yet: the kick settings' },
};

export interface MoveSpec {
  design: string;
  moveId: string;
  kind: MoveKind;
  move: Move;
  nLib: number;
  segments: number;
  windows: number;
  baseRates: Float64Array; // per clip frame
  /** Library channels the search samples; the others follow by iterative learning (ILC). */
  sampled: number[];
  gyro: boolean;
  gyroMax: number;
}

/** Today's per-frame clip rate for a move: MotionPlayer's rate table at today's wanted speed. */
export function todayRates(w: PolishWorld, move: Move): Float64Array {
  const set = mocapSet(w.r);
  if (!set) throw new Error(`no mocap set for ${w.designId}`);
  const k = TODAY[moveKind(move)];
  const table = set.rates(move, k.mask);
  const out = new Float64Array(move.frames);
  for (let f = 0; f < move.frames; f++) out[f] = Math.max(0.05, Math.min(k.speed, table[f] * k.limitScale));
  return out;
}

export function moveSpec(w: PolishWorld, move: Move): MoveSpec {
  const kind = moveKind(move);
  const lib = w.lib;
  const segments = Math.ceil((move.duration + TAIL_S) / KNOT_S - 1e-9);
  const idx = (re: RegExp) => lib.joints.map((n, i) => (re.test(n) ? i : -1)).filter((i) => i >= 0);
  const legs = idx(/^(hip_|knee_|ankle_)/);
  const waist = idx(/^waist_/);
  const armOf = (s: string) => idx(new RegExp(`^(shoulder_|elbow_).*_${s}$`));
  let sampled: number[];
  if (kind === 'punch') sampled = [...legs, ...waist, ...armOf(move.side === 'r' ? 'r' : 'l')];
  else if (kind === 'kick') sampled = [...legs, ...waist];
  else sampled = [...legs, ...waist, ...armOf('l'), ...armOf('r')];
  const gyro = (kind === 'kick' || kind === 'flashy') && !!w.gyro;
  return {
    design: w.designId, moveId: move.id, kind, move, nLib: lib.joints.length, segments,
    windows: Math.ceil(segments / 2), baseRates: todayRates(w, move), sampled: sampled.sort((a, b) => a - b), gyro,
    gyroMax: w.gyro?.spec.maxTorqueNm ?? 0,
  };
}

/** The full set of optimised quantities of one move. */
export class PlanState {
  dq: Float64Array;
  warp: Float64Array;
  gyroFF: Float64Array | null;
  fb: FeedbackGains;
  deadband: DeadBands;
  nominal: Float64Array | null = null;
  nominalSamples = 0;
  /** Frozen per-frame rates (quantized as stored); null: derived from the warp knots. */
  ratesOverride: Float64Array | null = null;
  /** The feedback's reference track (quantized as stored), per clip frame. */
  track: Float64Array | null = null;

  constructor(readonly spec: MoveSpec) {
    this.dq = new Float64Array((spec.segments + 3) * spec.nLib);
    this.warp = new Float64Array(spec.segments + 1);
    this.gyroFF = spec.gyro ? new Float64Array((spec.segments + 1) * 2) : null;
    this.fb = { ...DEFAULT_FEEDBACK };
    this.deadband = { ...DEFAULT_BANDS };
  }

  clone(): PlanState {
    const p = new PlanState(this.spec);
    p.dq.set(this.dq);
    p.warp.set(this.warp);
    if (this.gyroFF && p.gyroFF) p.gyroFF.set(this.gyroFF);
    p.fb = { ...this.fb };
    p.deadband = { ...this.deadband };
    p.nominal = this.nominal;
    p.nominalSamples = this.nominalSamples;
    p.ratesOverride = this.ratesOverride ? Float64Array.from(this.ratesOverride) : null;
    p.track = this.track;
    return p;
  }

  /** Clip rate per frame: today's × e^warp(τ), within [0.05, MAX_RATE]. */
  rates(): Float64Array {
    if (this.ratesOverride) return this.ratesOverride;
    const s = this.spec, m = s.move;
    const out = new Float64Array(m.frames);
    for (let f = 0; f < m.frames; f++) {
      const x = f / m.fps / KNOT_S;
      const i = Math.min(this.warp.length - 2, Math.floor(x)), u = x - i;
      const wv = this.warp[i] * (1 - u) + this.warp[i + 1] * u;
      out[f] = Math.max(0.05, Math.min(MAX_RATE, s.baseRates[f] * Math.exp(wv)));
    }
    return out;
  }

  toPlan(nominal: Float64Array | null = this.nominal, nominalSamples = this.nominalSamples): PolishPlan {
    const s = this.spec;
    return {
      knotS: KNOT_S, segments: s.segments, tailS: TAIL_S, rates: this.rates(), dq: this.dq, libJoints: s.nLib,
      gyroFF: this.gyroFF, fb: this.fb, deadband: this.deadband, nominal, nominalSamples,
      track: this.track, trackFrames: this.track ? this.track.length / TRACK_STRIDE : 0,
    };
  }
}

/** One optimisation variable. */
export type Var =
  | { kind: 'dq'; point: number; ch: number }
  | { kind: 'warp'; knot: number }
  | { kind: 'gyro'; knot: number; axis: number };

export function windowVars(spec: MoveSpec, k: number, channels: readonly number[] = spec.sampled, merged = 1, dqOnly = false): Var[] {
  const vars: Var[] = [];
  const nPts = spec.segments + 3;
  const k0 = k - (merged - 1);
  const points: number[] = [];
  for (let kk = k0; kk <= k; kk++) {
    if (kk === 0) points.push(0, 1, 2);
    points.push(2 * kk + 3, 2 * kk + 4);
  }
  for (const p of points) if (p < nPts) for (const ch of channels) vars.push({ kind: 'dq', point: p, ch });
  if (dqOnly) return vars;
  const knots: number[] = [];
  for (let kk = k0; kk <= k; kk++) {
    if (kk === 0) knots.push(0);
    knots.push(2 * kk + 1, 2 * kk + 2);
  }
  const clipKnots = Math.ceil(spec.move.duration / KNOT_S) + 1; // warp past the clip end does nothing
  for (const kn of knots) if (kn <= spec.segments && kn <= clipKnots) vars.push({ kind: 'warp', knot: kn });
  if (spec.gyro) for (const kn of knots) if (kn <= spec.segments) for (const axis of [0, 1]) vars.push({ kind: 'gyro', knot: kn, axis });
  return vars;
}

export function readVars(p: PlanState, vars: readonly Var[]): Float64Array {
  const out = new Float64Array(vars.length);
  vars.forEach((v, i) => {
    if (v.kind === 'dq') out[i] = p.dq[v.point * p.spec.nLib + v.ch];
    else if (v.kind === 'warp') out[i] = p.warp[v.knot];
    else out[i] = p.gyroFF![v.knot * 2 + v.axis];
  });
  return out;
}

export function writeVars(p: PlanState, vars: readonly Var[], x: ArrayLike<number>): void {
  vars.forEach((v, i) => {
    if (v.kind === 'dq') p.dq[v.point * p.spec.nLib + v.ch] = x[i];
    else if (v.kind === 'warp') p.warp[v.knot] = x[i];
    else p.gyroFF![v.knot * 2 + v.axis] = x[i];
  });
}

export function varBounds(spec: MoveSpec, vars: readonly Var[], legSigma = 0.05, armSigma = 0.03): { lo: Float64Array; hi: Float64Array; sigma: Float64Array } {
  const n = vars.length;
  const lo = new Float64Array(n), hi = new Float64Array(n), sigma = new Float64Array(n);
  vars.forEach((v, i) => {
    if (v.kind === 'dq') {
      lo[i] = -DQ_MAX;
      hi[i] = DQ_MAX;
      sigma[i] = isArmChannel(spec, v.ch) ? armSigma : legSigma;
    } else if (v.kind === 'warp') {
      lo[i] = -WARP_MAX;
      hi[i] = WARP_MAX;
      sigma[i] = 0.15;
    } else {
      lo[i] = -spec.gyroMax;
      hi[i] = spec.gyroMax;
      sigma[i] = 0.2 * spec.gyroMax;
    }
  });
  return { lo, hi, sigma };
}

let armNames: Set<number> | null = null;
function isArmChannel(spec: MoveSpec, ch: number): boolean {
  void spec;
  return armNames ? armNames.has(ch) : ch >= 3 && ch <= 6 || ch >= 13 && ch <= 16;
}

/** Library channel layout (shared by every design: the same 23 joint names in the same order). */
export function setArmChannels(libJoints: readonly string[]): void {
  armNames = new Set(libJoints.map((n, i) => (/^(shoulder_|elbow_)/.test(n) ? i : -1)).filter((i) => i >= 0));
}

/** Spline jerk penalty of a plan's Δq (analytic, mean over segments and joints, (jerk / 300 rad/s³)²). */
export function splineJerkCost(p: PlanState, rate = 1): number {
  const s = p.spec, nl = s.nLib, h = KNOT_S;
  let sum = 0, n = 0;
  for (let j = 0; j < s.segments; j++) {
    for (let c = 0; c < nl; c++) {
      const o = j * nl + c;
      const jerk = (-p.dq[o] + 3 * p.dq[o + nl] - 3 * p.dq[o + 2 * nl] + p.dq[o + 3 * nl]) / (h * h * h);
      const v = (jerk * rate * rate * rate) / 300;
      sum += v * v;
      n++;
    }
  }
  return n ? sum / n : 0;
}
