// Source-side motion: a BVH clip turned into the landmarks the retargeter and the segmenter need,
// in the robot's world convention (x forward, y left, z up, metres, floor at z = 0).
//
// The CMU skeleton faces +z with its left along +x and y up; the canonical frame is a cyclic
// permutation of those axes (a proper rotation), so segment frames keep their handedness:
//   canonical (x, y, z) = (bvh z, bvh x, bvh y) · UNIT_M
// Zero rotation in the CMU bind pose is upright and facing forward, so the canonical pelvis, chest
// and head frames read directly as "x forward, y left, z up". The bind-pose legs are splayed ~20°
// (the ASF femur axis), so a foot joint frame is rolled by that splay when the leg hangs straight:
// foot frames are corrected by the bind-pose hip→ankle direction (see footCalibration).
import type { Vec3 } from '../../core/types';
import { bvhPose, firstFrameIsRestPose, newBvhPose, readMat, readVec, type BvhClip } from './bvh';
import { cross, dot, mulMM, mulMV, normalize, rotZ, transpose, axisAngle, type Mat3 } from './math';

/** CMU ASF length unit: 1/0.45 inch. */
export const CMU_UNIT_M = 0.0254 / 0.45;

export type Side = 'l' | 'r';
export const SIDES: readonly Side[] = ['l', 'r'];
export const sideSign = (s: Side): number => (s === 'l' ? 1 : -1);
export const otherSide = (s: Side): Side => (s === 'l' ? 'r' : 'l');

/** Points tracked on the source body (per side names end in L/R). */
export const POINTS = [
  'pelvis', 'hipC', 'chest', 'neck', 'head', 'headTop',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'ballL', 'ballR', 'toeL', 'toeR',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'fistL', 'fistR',
] as const;
export type PointId = (typeof POINTS)[number];

/** Segment frames tracked on the source body. */
export const FRAMES = ['pelvis', 'chest', 'head', 'footL', 'footR'] as const;
export type FrameId = (typeof FRAMES)[number];

export interface SkeletonMap {
  hips: string;
  chest: string;
  neck: string;
  head: string; // joint whose End Site is the top of the head
  hip: Record<Side, string>;
  knee: Record<Side, string>;
  ankle: Record<Side, string>;
  ball: Record<Side, string>; // joint at the ball of the foot; its End Site is the toe tip
  shoulder: Record<Side, string>;
  elbow: Record<Side, string>;
  wrist: Record<Side, string>;
}

export const CMU_SKELETON: SkeletonMap = {
  hips: 'Hips',
  chest: 'Spine1',
  neck: 'Neck1',
  head: 'Head',
  hip: { l: 'LeftUpLeg', r: 'RightUpLeg' },
  knee: { l: 'LeftLeg', r: 'RightLeg' },
  ankle: { l: 'LeftFoot', r: 'RightFoot' },
  ball: { l: 'LeftToeBase', r: 'RightToeBase' },
  shoulder: { l: 'LeftArm', r: 'RightArm' },
  elbow: { l: 'LeftForeArm', r: 'RightForeArm' },
  wrist: { l: 'LeftHand', r: 'RightHand' },
};

/** Fist centre beyond the wrist along the forearm, as a fraction of the forearm length. */
const FIST_BEYOND_WRIST = 0.3;

export interface HumanDims {
  thigh: number;
  shin: number;
  legLength: number; // thigh + shin
  upper: number; // shoulder → elbow
  fore: number; // elbow → fist centre
  armLength: number;
  hipHalfWidth: number;
  shoulderHalfWidth: number;
  shoulderHeight: number; // shoulders above the hip centre (upright, torso frame)
  ankleHeight: number; // ankle joint above the floor, standing
  standHipHeight: number; // hip centre above the floor, standing
}

export interface HumanTrack {
  name: string;
  fps: number;
  n: number;
  /** n × 3 per point, canonical metres. */
  p: Record<PointId, Float64Array>;
  /** n × 9 per frame, canonical rotations (row-major). */
  r: Record<FrameId, Float64Array>;
  dims: HumanDims;
  mirrored: boolean;
}

// canonical = C · bvh (C permutes axes: x ← z, y ← x, z ← y)
const C: Mat3 = [0, 0, 1, 1, 0, 0, 0, 1, 0];
const CT = transpose(C);

function canonPoint(v: Vec3, unit: number, floor: number): Vec3 {
  return [v[2] * unit, v[0] * unit, v[1] * unit - floor];
}

const canonRot = (R: Mat3): Mat3 => mulMM(mulMM(C, R), CT);

export const pt = (tr: HumanTrack, id: PointId, i: number): Vec3 => readVec(tr.p[id], i);
export const fr = (tr: HumanTrack, id: FrameId, i: number): Mat3 => readMat(tr.r[id], i);

function lowQuantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/** Sum of bind-pose offsets from joint `a` down to its descendant `b` (file units). */
function bindVector(clip: BvhClip, a: string, b: string): Vec3 {
  const ja = clip.jointIndex.get(a)!;
  const o: Vec3 = [0, 0, 0];
  for (let j = clip.jointIndex.get(b)!; j !== ja && j >= 0; j = clip.joints[j].parent) {
    const off = clip.joints[j].offset;
    o[0] += off[0]; o[1] += off[1]; o[2] += off[2];
  }
  return o;
}

/**
 * Correction that turns a foot joint frame into an anatomical sole frame (x toes, z up):
 * R_sole = R_joint · Cᵀ, where C is the minimal rotation taking the bind-pose hip→ankle direction
 * to straight down. With the leg hanging straight and the ankle at rest, R_joint = C, so the sole
 * reads level. (CMU: C is a ~20° roll about the forward axis, opposite for the two legs.)
 */
export function footCalibration(clip: BvhClip, hip: string, ankle: string): Mat3 {
  const v = bindVector(clip, hip, ankle);
  const dir = normalize([v[2], v[0], v[1]], [0, 0, -1]); // canonical axes
  const down: Vec3 = [0, 0, -1];
  const axis = cross(dir, down);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  if (s < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return axisAngle([axis[0] / s, axis[1] / s, axis[2] / s], Math.atan2(s, dot(dir, down)));
}

/** Upright: chest axis within ~37° of vertical and the hips well above the lowest foot point. */
const UPRIGHT_CHEST_Z = 0.8;
const UPRIGHT_HIP_OVER_FOOT = 0.7; // × leg length
const MIN_UPRIGHT_FRAMES = 30; // source frames

export interface TrackOptions {
  unit?: number; // metres per file unit
  skeleton?: SkeletonMap;
  /** Output rate; the source is linearly resampled (rotations are re-orthonormalized). */
  fps?: number;
}

/**
 * Build the landmark track for a clip: FK every frame, convert to the canonical frame, find the
 * floor (low quantile of the lowest toe point) and measure the actor's proportions.
 */
export function humanTrack(name: string, clip: BvhClip, opts: TrackOptions = {}): HumanTrack {
  const unit = opts.unit ?? CMU_UNIT_M;
  const sk = opts.skeleton ?? CMU_SKELETON;
  const J = (n: string) => {
    const i = clip.jointIndex.get(n);
    if (i === undefined) throw new Error(`${name}: skeleton has no joint '${n}'`);
    return i;
  };
  const first = firstFrameIsRestPose(clip) ? 1 : 0;
  const srcN = clip.frameCount - first;
  const srcFps = 1 / clip.frameTime;
  const fps = opts.fps ?? srcFps;
  const n = Math.max(1, Math.floor(((srcN - 1) * fps) / srcFps) + 1);

  // Raw FK at the source rate, in canonical axes and metres, floor not yet removed.
  const idx = {
    hips: J(sk.hips), chest: J(sk.chest), neck: J(sk.neck), head: J(sk.head),
    hip: { l: J(sk.hip.l), r: J(sk.hip.r) }, knee: { l: J(sk.knee.l), r: J(sk.knee.r) },
    ankle: { l: J(sk.ankle.l), r: J(sk.ankle.r) }, ball: { l: J(sk.ball.l), r: J(sk.ball.r) },
    shoulder: { l: J(sk.shoulder.l), r: J(sk.shoulder.r) }, elbow: { l: J(sk.elbow.l), r: J(sk.elbow.r) },
    wrist: { l: J(sk.wrist.l), r: J(sk.wrist.r) },
  };
  const rawP: Record<PointId, Float64Array> = Object.fromEntries(POINTS.map((k) => [k, new Float64Array(srcN * 3)])) as Record<PointId, Float64Array>;
  const rawR: Record<FrameId, Float64Array> = Object.fromEntries(FRAMES.map((k) => [k, new Float64Array(srcN * 9)])) as Record<FrameId, Float64Array>;
  const pose = newBvhPose(clip);
  const footFix = {
    l: transpose(footCalibration(clip, sk.hip.l, sk.ankle.l)),
    r: transpose(footCalibration(clip, sk.hip.r, sk.ankle.r)),
  };
  const legLen = ((segLen(clip, sk.hip.l, sk.knee.l, unit) + segLen(clip, sk.knee.l, sk.ankle.l, unit)
    + segLen(clip, sk.hip.r, sk.knee.r, unit) + segLen(clip, sk.knee.r, sk.ankle.r, unit)) / 2);
  const lowest: number[] = [];
  const uprightLowest: number[] = [];
  for (let f = 0; f < srcN; f++) {
    bvhPose(clip, f + first, pose);
    const P = (j: number): Vec3 => canonPoint(readVec(pose.pos, j), unit, 0);
    const E = (j: number): Vec3 => canonPoint(readVec(pose.end, j), unit, 0);
    const R = (j: number): Mat3 => canonRot(readMat(pose.rot, j));
    const put = (id: PointId, v: Vec3) => rawP[id].set(v, f * 3);
    const putR = (id: FrameId, m: Mat3) => rawR[id].set(m, f * 9);
    const hl = P(idx.hip.l), hr = P(idx.hip.r);
    put('pelvis', P(idx.hips));
    put('hipC', [(hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2, (hl[2] + hr[2]) / 2]);
    put('chest', P(idx.chest));
    put('neck', P(idx.neck));
    put('head', P(idx.head));
    put('headTop', E(idx.head));
    for (const s of SIDES) {
      const S = s === 'l' ? 'L' : 'R';
      put(`hip${S}`, P(idx.hip[s]));
      put(`knee${S}`, P(idx.knee[s]));
      put(`ankle${S}`, P(idx.ankle[s]));
      put(`ball${S}`, P(idx.ball[s]));
      put(`toe${S}`, E(idx.ball[s]));
      const el = P(idx.elbow[s]), wr = P(idx.wrist[s]);
      put(`shoulder${S}`, P(idx.shoulder[s]));
      put(`elbow${S}`, el);
      put(`wrist${S}`, wr);
      put(`fist${S}`, [wr[0] + (wr[0] - el[0]) * FIST_BEYOND_WRIST, wr[1] + (wr[1] - el[1]) * FIST_BEYOND_WRIST, wr[2] + (wr[2] - el[2]) * FIST_BEYOND_WRIST]);
      putR(`foot${S}`, mulMM(R(idx.ankle[s]), footFix[s]));
    }
    putR('pelvis', R(idx.hips));
    putR('chest', R(idx.chest));
    putR('head', R(idx.head));
    const low = Math.min(rawP.ballL[f * 3 + 2], rawP.ballR[f * 3 + 2], rawP.toeL[f * 3 + 2], rawP.toeR[f * 3 + 2]);
    lowest.push(low);
    const chestZ = rawR.chest[f * 9 + 8];
    if (chestZ > UPRIGHT_CHEST_Z && rawP.hipC[f * 3 + 2] - low > UPRIGHT_HIP_OVER_FOOT * legLen) uprightLowest.push(low);
  }
  // The floor: a standing actor's toes rest on it; a low quantile ignores the odd dip through it.
  // Lying down the toes point up (or the solver sinks a hand through the mat), so only upright
  // frames count when the clip has enough of them.
  const floor = lowQuantile(uprightLowest.length >= MIN_UPRIGHT_FRAMES ? uprightLowest : lowest, 0.1);
  for (const k of POINTS) for (let f = 0; f < srcN; f++) rawP[k][f * 3 + 2] -= floor;

  const p = Object.fromEntries(POINTS.map((k) => [k, resampleVec(rawP[k], srcN, n, srcFps, fps)])) as Record<PointId, Float64Array>;
  const r = Object.fromEntries(FRAMES.map((k) => [k, resampleRot(rawR[k], srcN, n, srcFps, fps)])) as Record<FrameId, Float64Array>;
  const tr: HumanTrack = { name, fps, n, p, r, dims: undefined as unknown as HumanDims, mirrored: false };
  tr.dims = measure(clip, sk, unit, tr);
  return tr;
}

function resampleVec(src: Float64Array, srcN: number, n: number, srcFps: number, fps: number): Float64Array {
  if (n === srcN && fps === srcFps) return src;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (i / fps) * srcFps;
    const a = Math.min(srcN - 1, Math.floor(t));
    const b = Math.min(srcN - 1, a + 1);
    const w = t - a;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = src[a * 3 + k] * (1 - w) + src[b * 3 + k] * w;
  }
  return out;
}

function resampleRot(src: Float64Array, srcN: number, n: number, srcFps: number, fps: number): Float64Array {
  if (n === srcN && fps === srcFps) return src;
  const out = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const t = (i / fps) * srcFps;
    const a = Math.min(srcN - 1, Math.floor(t));
    const b = Math.min(srcN - 1, a + 1);
    const w = t - a;
    const m = new Array(9) as Mat3;
    for (let k = 0; k < 9; k++) m[k] = src[a * 9 + k] * (1 - w) + src[b * 9 + k] * w;
    out.set(orthoNorm(m), i * 9);
  }
  return out;
}

function orthoNorm(m: Mat3): Mat3 {
  // Columns x and z, Gram-Schmidt: close rotations blend to a near-rotation, this snaps it back.
  const x = [m[0], m[3], m[6]];
  const nx = Math.hypot(x[0], x[1], x[2]) || 1;
  x[0] /= nx; x[1] /= nx; x[2] /= nx;
  const y = [m[1], m[4], m[7]];
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y[0] -= d * x[0]; y[1] -= d * x[1]; y[2] -= d * x[2];
  const ny = Math.hypot(y[0], y[1], y[2]) || 1;
  y[0] /= ny; y[1] /= ny; y[2] /= ny;
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** Bind-pose distance from joint a down to its descendant b (one bone in practice: rigid). */
function segLen(clip: BvhClip, a: string, b: string, unit: number): number {
  const ja = clip.jointIndex.get(a)!;
  const o: Vec3 = [0, 0, 0];
  for (let j = clip.jointIndex.get(b)!; j !== ja && j >= 0; j = clip.joints[j].parent) {
    const off = clip.joints[j].offset;
    o[0] += off[0]; o[1] += off[1]; o[2] += off[2];
  }
  return Math.hypot(o[0], o[1], o[2]) * unit;
}

function measure(clip: BvhClip, sk: SkeletonMap, unit: number, tr: HumanTrack): HumanDims {
  const thigh = (segLen(clip, sk.hip.l, sk.knee.l, unit) + segLen(clip, sk.hip.r, sk.knee.r, unit)) / 2;
  const shin = (segLen(clip, sk.knee.l, sk.ankle.l, unit) + segLen(clip, sk.knee.r, sk.ankle.r, unit)) / 2;
  const upper = (segLen(clip, sk.shoulder.l, sk.elbow.l, unit) + segLen(clip, sk.shoulder.r, sk.elbow.r, unit)) / 2;
  const foreRaw = (segLen(clip, sk.elbow.l, sk.wrist.l, unit) + segLen(clip, sk.elbow.r, sk.wrist.r, unit)) / 2;
  const fore = foreRaw * (1 + FIST_BEYOND_WRIST);
  // Widths and heights from the tracked frames (in the body's own frames, so poses don't matter).
  const hipW: number[] = [], shW: number[] = [], shH: number[] = [], ankH: number[] = [], ankUpright: number[] = [];
  for (let i = 0; i < tr.n; i++) {
    const hl = pt(tr, 'hipL', i), hr = pt(tr, 'hipR', i);
    hipW.push(Math.hypot(hl[0] - hr[0], hl[1] - hr[1], hl[2] - hr[2]) / 2);
    const sl = pt(tr, 'shoulderL', i), sr = pt(tr, 'shoulderR', i);
    shW.push(Math.hypot(sl[0] - sr[0], sl[1] - sr[1], sl[2] - sr[2]) / 2);
    const hc = pt(tr, 'hipC', i);
    const chest = fr(tr, 'chest', i);
    const mid: Vec3 = [(sl[0] + sr[0]) / 2 - hc[0], (sl[1] + sr[1]) / 2 - hc[1], (sl[2] + sr[2]) / 2 - hc[2]];
    shH.push(mid[0] * chest[2] + mid[1] * chest[5] + mid[2] * chest[8]);
    const ank = Math.min(pt(tr, 'ankleL', i)[2], pt(tr, 'ankleR', i)[2]);
    ankH.push(ank);
    if (chest[8] > UPRIGHT_CHEST_Z && hc[2] > UPRIGHT_HIP_OVER_FOOT * (thigh + shin)) ankUpright.push(ank);
  }
  const median = (v: number[]) => lowQuantile(v, 0.5);
  // Flat-footed ankle height: lying down the ankles sink lower than they ever do standing.
  const ankleHeight = Math.max(0.03, lowQuantile(ankUpright.length >= MIN_UPRIGHT_FRAMES / 2 ? ankUpright : ankH, 0.1));
  return {
    thigh, shin, legLength: thigh + shin, upper, fore, armLength: upper + fore,
    hipHalfWidth: median(hipW), shoulderHalfWidth: median(shW), shoulderHeight: median(shH),
    ankleHeight, standHipHeight: thigh + shin + ankleHeight,
  };
}

// ---------------------------------------------------------------- mirroring

const MIRROR: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, 1];

/** Swap the side letter of a per-side id ('fistL' ↔ 'fistR'); shared ids map to themselves. */
function swapSide<T extends string>(id: T): T {
  if (id.endsWith('L')) return (id.slice(0, -1) + 'R') as T;
  if (id.endsWith('R')) return (id.slice(0, -1) + 'L') as T;
  return id;
}

/**
 * Mirror a track across the world xz plane and swap sides: a southpaw becomes orthodox.
 * Points reflect (y → −y); frames conjugate by the reflection so they stay right-handed with
 * y pointing to the body's (new) left: R' = M·R·M.
 */
export function mirrorTrack(tr: HumanTrack): HumanTrack {
  const p = {} as Record<PointId, Float64Array>;
  for (const k of POINTS) {
    const src = tr.p[swapSide(k)];
    const out = new Float64Array(src.length);
    for (let i = 0; i < tr.n; i++) {
      out[i * 3] = src[i * 3];
      out[i * 3 + 1] = -src[i * 3 + 1];
      out[i * 3 + 2] = src[i * 3 + 2];
    }
    p[k] = out;
  }
  const r = {} as Record<FrameId, Float64Array>;
  for (const k of FRAMES) {
    const src = tr.r[swapSide(k)];
    const out = new Float64Array(src.length);
    for (let i = 0; i < tr.n; i++) out.set(mulMM(mulMM(MIRROR, readMat(src, i)), MIRROR), i * 9);
    r[k] = out;
  }
  return { ...tr, p, r, mirrored: !tr.mirrored };
}

/**
 * The same track with the whole actor lifted on a ballistic arc over frames (from, to): height
 * 4·h·u·(1 − u) for u from 0 to 1, h = g·T²/8 for the arc's duration T (the height a body thrown
 * up for T seconds reaches), times `scale`. Feet planted in the window leave the mat, so the
 * contacts read it as a leap. Used to turn a lunge into a leap (a superman punch).
 */
export function leapTrack(tr: HumanTrack, from: number, to: number, scale = 1): HumanTrack {
  const T = (to - from) / tr.fps;
  const h = (9.81 * T * T) / 8 * scale;
  const p = {} as Record<PointId, Float64Array>;
  for (const k of POINTS) {
    const out = new Float64Array(tr.p[k]);
    for (let i = Math.max(0, from + 1); i < Math.min(tr.n, to); i++) {
      const u = (i - from) / (to - from);
      out[i * 3 + 2] += 4 * h * u * (1 - u);
    }
    p[k] = out;
  }
  return { ...tr, p };
}

/**
 * The same track with a full extra turn: from frame `from` to `to` the whole actor turns by
 * `angle` (rad, eased in and out) about the vertical through the foot bearing the weight (the
 * ball of the planted foot; the `support` foot's when both or neither are down), and from `to`
 * on keeps that turn. With angle = ±2π the motion after `to` is unchanged: the actor just spins
 * once on the support foot on the way (a side kick → a spinning side kick; a roundhouse → the
 * spin of a tornado kick).
 */
export function spinTrack(tr: HumanTrack, from: number, to: number, angle: number, support: Side): HumanTrack {
  const turn = (i: number): number => {
    if (i <= from) return 0;
    if (i >= to) return angle;
    const u = (i - from) / (to - from);
    return angle * u * u * (3 - 2 * u);
  };
  // Pivot: planted-ness of each ball (low and slow), smoothed, as the weight between them.
  const down = (id: 'ballL' | 'ballR', i: number): number => {
    const a = Math.max(0, i - 1), b = Math.min(tr.n - 1, i + 1);
    const p = readVec(tr.p[id], a), q = readVec(tr.p[id], b), z = readVec(tr.p[id], i)[2];
    const v = (Math.hypot(q[0] - p[0], q[1] - p[1]) * tr.fps) / Math.max(1, b - a);
    return z < SPIN_PIVOT_HEIGHT_M && v < SPIN_PIVOT_SPEED ? 1 : 0;
  };
  const pivot: Vec3[] = [];
  for (let i = 0; i < tr.n; i++) {
    let l = 0, r = 0;
    for (let k = Math.max(0, i - SPIN_PIVOT_SMOOTH); k <= Math.min(tr.n - 1, i + SPIN_PIVOT_SMOOTH); k++) {
      l += down('ballL', k);
      r += down('ballR', k);
    }
    // 0: left foot, 1: right foot. Both down (or neither): the support foot of the strike.
    const sup = support === 'r' ? 1 : 0;
    const w = (l > 0) === (r > 0) ? sup : r > 0 ? 1 : 0;
    const bl = readVec(tr.p.ballL, i), br = readVec(tr.p.ballR, i);
    pivot.push([bl[0] + (br[0] - bl[0]) * w, bl[1] + (br[1] - bl[1]) * w, 0]);
  }
  const p = {} as Record<PointId, Float64Array>;
  for (const k of POINTS) {
    const src = tr.p[k];
    const out = new Float64Array(src);
    for (let i = from + 1; i < tr.n; i++) {
      const c = pivot[i];
      const v = mulMV(rotZ(turn(i)), [src[i * 3] - c[0], src[i * 3 + 1] - c[1], src[i * 3 + 2]]);
      out[i * 3] = c[0] + v[0];
      out[i * 3 + 1] = c[1] + v[1];
    }
    p[k] = out;
  }
  const r = {} as Record<FrameId, Float64Array>;
  for (const k of FRAMES) {
    const out = new Float64Array(tr.r[k]);
    for (let i = from + 1; i < tr.n; i++) out.set(mulMM(rotZ(turn(i)), readMat(tr.r[k], i)), i * 9);
    r[k] = out;
  }
  return { ...tr, p, r };
}

const SPIN_PIVOT_HEIGHT_M = 0.04; // a ball this low ...
const SPIN_PIVOT_SPEED = 0.35; // ... and this slow (m/s) bears the weight
const SPIN_PIVOT_SMOOTH = 4; // ± frames

/** Load a track from BVH text (convenience for tools and the preview). */
export function trackFromBvh(name: string, clip: BvhClip, fps?: number): HumanTrack {
  return humanTrack(name, clip, { fps });
}
