// Per-frame kinematic signals the segmenter reads off a human track: limb speeds, heights,
// contacts, uprightness and facing estimates. All in the canonical frame (x fwd, y left, z up).
import type { Vec3 } from '../../core/types';
import { humanContacts } from './contacts';
import { fr, pt, type HumanTrack, type PointId, type Side } from './human';
import { col, norm, smooth, sub, wrapAngle, yawOfMat } from './math';

export interface Signals {
  tr: HumanTrack;
  n: number;
  fps: number;
  contacts: Uint8Array;
  /** Fist speed relative to the hip centre (locomotion removed), m/s, lightly smoothed. */
  fistSpeed: Record<Side, Float64Array>;
  /** Ankle speed in the world, m/s. */
  ankleSpeed: Record<Side, Float64Array>;
  /** Hip centre height / standing hip height. */
  hipRatio: Float64Array;
  /** Chest up-axis z component (1 upright, 0 lying). */
  chestUp: Float64Array;
  pelvisYaw: Float64Array;
  chestYaw: Float64Array;
  /** Whole-body motion: mean point speed, m/s (stillness detection). */
  bodySpeed: Float64Array;
}

const SMOOTH = 3;
const S: Record<Side, 'L' | 'R'> = { l: 'L', r: 'R' };

export function velocity(tr: HumanTrack, id: PointId, i: number): Vec3 {
  const a = Math.max(0, i - 1), b = Math.min(tr.n - 1, i + 1);
  if (a === b) return [0, 0, 0];
  const d = sub(pt(tr, id, b), pt(tr, id, a));
  const k = tr.fps / (b - a);
  return [d[0] * k, d[1] * k, d[2] * k];
}

export function computeSignals(tr: HumanTrack): Signals {
  const n = tr.n;
  const series = () => new Float64Array(n);
  const fistRaw = { l: series(), r: series() }, ankleRaw = { l: series(), r: series() };
  const hipRatio = series(), chestUp = series(), pelvisYaw = series(), chestYaw = series(), bodyRaw = series();
  const bodyPts: PointId[] = ['hipC', 'chest', 'head', 'fistL', 'fistR', 'ankleL', 'ankleR', 'kneeL', 'kneeR'];
  for (let i = 0; i < n; i++) {
    const hv = velocity(tr, 'hipC', i);
    for (const s of ['l', 'r'] as const) {
      fistRaw[s][i] = norm(sub(velocity(tr, `fist${S[s]}`, i), hv));
      ankleRaw[s][i] = norm(velocity(tr, `ankle${S[s]}`, i));
    }
    hipRatio[i] = pt(tr, 'hipC', i)[2] / tr.dims.standHipHeight;
    chestUp[i] = col(fr(tr, 'chest', i), 2)[2];
    pelvisYaw[i] = yawOfMat(fr(tr, 'pelvis', i));
    chestYaw[i] = yawOfMat(fr(tr, 'chest', i));
    let s = 0;
    for (const id of bodyPts) s += norm(velocity(tr, id, i));
    bodyRaw[i] = s / bodyPts.length;
  }
  return {
    tr, n, fps: tr.fps, contacts: humanContacts(tr),
    fistSpeed: { l: smooth(fistRaw.l, SMOOTH), r: smooth(fistRaw.r, SMOOTH) },
    ankleSpeed: { l: smooth(ankleRaw.l, SMOOTH), r: smooth(ankleRaw.r, SMOOTH) },
    hipRatio, chestUp, pelvisYaw, chestYaw, bodySpeed: smooth(bodyRaw, 9),
  };
}

/** Local maxima above `min`, at least `gap` frames apart (the larger one wins). */
export function peaks(x: ArrayLike<number>, min: number, gap: number): number[] {
  const cand: number[] = [];
  for (let i = 1; i < x.length - 1; i++) if (x[i] >= min && x[i] >= x[i - 1] && x[i] > x[i + 1]) cand.push(i);
  cand.sort((a, b) => x[b] - x[a]);
  const kept: number[] = [];
  for (const c of cand) if (kept.every((k) => Math.abs(k - c) >= gap)) kept.push(c);
  return kept.sort((a, b) => a - b);
}

/** Walk from `i` in direction `dir` while x keeps falling; stop below `floor` or at `limit` frames. */
export function valley(x: ArrayLike<number>, i: number, dir: 1 | -1, floor: number, limit: number): number {
  let k = i;
  for (let steps = 0; steps < limit; steps++) {
    const nx = k + dir;
    if (nx < 0 || nx >= x.length) break;
    if (x[nx] > x[k] + 1e-9) break; // rising again: a valley
    k = nx;
    if (x[k] < floor) break;
  }
  return k;
}

/** Circular mean of angles. */
export function meanAngle(a: readonly number[]): number {
  let s = 0, c = 0;
  for (const x of a) {
    s += Math.sin(x);
    c += Math.cos(x);
  }
  return Math.atan2(s, c);
}

export const angleDiff = (a: number, b: number): number => wrapAngle(a - b);

/** Horizontal yaw of a vector. */
export const yawOf = (v: Vec3): number => Math.atan2(v[1], v[0]);

/** Vector in the frame that faces `yaw` (x forward, y left). */
export function inFacing(v: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}
