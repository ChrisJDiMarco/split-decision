// Segment + retargeted clip → one library move: frames sliced, re-expressed in the move frame
// (x toward the opponent, pelvis starting over the origin), loops closed, and the numbers the
// tracking controller plans with (strike target, peak speed, travel, time-scale limit, quality).
import type { Quat, Vec3 } from '../../core/types';
import { encodeAngles, encodeBytes, encodeRoot } from './codec';
import { matFromQuat, mulMM, mulMV, quatFromMat, quatSlerp, rotZ, type Mat3 } from './math';
import { fk, newFrames, type RobotModel } from './robot-model';
import type { Retargeted } from './retarget';
import type { Segment } from './segment';
import type { MoveJson, MoveQuality } from './types';

/** Joint speed may use this fraction of the motor's no-load speed when a move is sped up. */
export const SPEED_MARGIN = 0.9;
const MAX_SPEED_CAP = 3;
const MIN_SPEED_CAP = 0.2;
const LOOP_BLEND = 0.35; // fraction of a loop's frames that bend toward the first frame
const AT_LIMIT_RAD = 2e-3;
const SPEED_SMOOTH = 2; // ± frames averaged when measuring joint speed

export interface MoveMetrics {
  fistErr: number;
  footErr: number;
  kneeErr: number;
  elbowErr: number;
  strikerErr: number; // striker: requested vs reached at reach, m (0 for non-strikes)
  limitRate: number;
  jointPeak: Float64Array; // rad/s at 1×, per joint
  slowest: string; // joint that caps maxSpeed
  trunkDrop: number; // max |trunk mat correction|, m
}

export interface BuiltMove {
  json: MoveJson;
  q: Float32Array;
  root: Float32Array;
  contacts: Uint8Array;
  metrics: MoveMetrics;
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Yaw of the move frame: the segment's facing (mirrored with the track), walks along travel. */
function moveYaw(seg: Segment, r: Retargeted, k0: number, frames: number): number {
  const yaw = seg.mirrored ? -seg.yaw : seg.yaw;
  if (!seg.loop || !seg.label.startsWith('walk')) return yaw;
  const a = k0 * 3, b = (k0 + frames - 1) * 3;
  const dx = r.rootPos[b] - r.rootPos[a], dy = r.rootPos[b + 1] - r.rootPos[a + 1];
  const travel = Math.atan2(dy, dx);
  return seg.label === 'walk_back' ? travel + Math.PI : travel;
}

function meanDist(a: Float64Array, b: Float64Array, k0: number, frames: number): number {
  let s = 0;
  for (let i = 0; i < frames * 2; i++) {
    const o = k0 * 6 + i * 3;
    s += Math.hypot(a[o] - b[o], a[o + 1] - b[o + 1], a[o + 2] - b[o + 2]);
  }
  return frames ? s / (frames * 2) : 0;
}

/** Bend the tail of a loop so its last frame equals its first (joints, height, attitude). */
function closeLoop(q: Float32Array, root: Float32Array, frames: number, nj: number, keepStride: boolean): void {
  if (frames < 4) return;
  const last = frames - 1;
  const L = Math.max(4, Math.round(frames * LOOP_BLEND));
  const dq = new Float64Array(nj);
  for (let j = 0; j < nj; j++) dq[j] = q[j] - q[last * nj + j];
  const dz = root[2] - root[last * 7 + 2];
  const dx = keepStride ? 0 : root[0] - root[last * 7];
  const dy = keepStride ? 0 : root[1] - root[last * 7 + 1];
  const q0: Quat = [root[3], root[4], root[5], root[6]];
  const qL: Quat = [root[last * 7 + 3], root[last * 7 + 4], root[last * 7 + 5], root[last * 7 + 6]];
  // World-frame correction D = R0 · RLᵀ, applied partially: R_i' = slerp(I, D, w) · R_i.
  const D = quatFromMat(mulMM(matFromQuat(q0), transposeM(matFromQuat(qL))));
  for (let i = frames - L; i < frames; i++) {
    const w = smoothstep((i - (frames - L)) / (L - 1));
    for (let j = 0; j < nj; j++) q[i * nj + j] += w * dq[j];
    root[i * 7] += w * dx;
    root[i * 7 + 1] += w * dy;
    root[i * 7 + 2] += w * dz;
    const Dw = quatSlerp([1, 0, 0, 0], D, w);
    const Ri = matFromQuat([root[i * 7 + 3], root[i * 7 + 4], root[i * 7 + 5], root[i * 7 + 6]]);
    const qi = quatFromMat(mulMM(matFromQuat(Dw), Ri));
    root.set(qi, i * 7 + 3);
  }
  // Exact seam.
  for (let j = 0; j < nj; j++) q[last * nj + j] = q[j];
  root.set(root.subarray(3, 7), last * 7 + 3);
  root[last * 7 + 2] = root[2];
}

function transposeM(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Build one move from a segment and the retarget of the (possibly mirrored) clip it came from. */
export function buildMove(seg: Segment, r: Retargeted, speedLimit: ArrayLike<number>): BuiltMove {
  const m: RobotModel = r.model;
  const nj = m.joints.length;
  const k0 = seg.start - r.from;
  const frames = Math.min(seg.end, r.from + r.n) - seg.start;
  if (k0 < 0 || frames < 2) throw new Error(`move ${seg.id}: segment [${seg.start}, ${seg.end}) outside the retarget`);
  const fps = r.fps;
  const yaw = moveYaw(seg, r, k0, frames);
  const Rinv = rotZ(-yaw);
  const x0 = r.rootPos[k0 * 3], y0 = r.rootPos[k0 * 3 + 1];

  const q = new Float32Array(frames * nj);
  const root = new Float32Array(frames * 7);
  const contacts = new Uint8Array(frames);
  let prevQ: Quat | null = null;
  for (let i = 0; i < frames; i++) {
    const k = k0 + i;
    for (let j = 0; j < nj; j++) q[i * nj + j] = r.q[k * nj + j];
    const p = mulMV(Rinv, [r.rootPos[k * 3] - x0, r.rootPos[k * 3 + 1] - y0, 0]);
    let rq = quatFromMat(mulMM(Rinv, Array.from(r.rootRot.subarray(k * 9, k * 9 + 9)) as Mat3));
    if (prevQ && rq[0] * prevQ[0] + rq[1] * prevQ[1] + rq[2] * prevQ[2] + rq[3] * prevQ[3] < 0) rq = [-rq[0], -rq[1], -rq[2], -rq[3]];
    prevQ = rq;
    root.set([p[0], p[1], r.rootPos[k * 3 + 2], rq[0], rq[1], rq[2], rq[3]], i * 7);
    contacts[i] = r.contacts[k];
  }
  if (seg.loop) closeLoop(q, root, frames, nj, seg.label.startsWith('walk'));

  // Striker numbers from the robot's own forward kinematics (move frame).
  const rel = (f: number) => Math.min(frames - 1, Math.max(0, f - seg.start));
  const strikerBody = seg.striker ? m.bodyIndex.get(seg.striker) ?? null : null;
  const f = newFrames(m);
  const strikerAt = (i: number): Vec3 => {
    const o = i * 7;
    fk(m, [root[o], root[o + 1], root[o + 2]], matFromQuat([root[o + 3], root[o + 4], root[o + 5], root[o + 6]]), q.subarray(i * nj, (i + 1) * nj), f);
    return f.pos[strikerBody!];
  };
  let target: Vec3 | null = null;
  let peakSpeed = 0;
  let strikerErr = 0;
  if (strikerBody !== null && seg.reach !== null && seg.impact !== null) {
    const reachI = rel(seg.reach), impI = rel(seg.impact);
    target = strikerAt(reachI).map((v) => Math.round(v * 1000) / 1000) as Vec3;
    const a = strikerAt(Math.max(0, impI - 1)), b = strikerAt(Math.min(frames - 1, impI + 1));
    const span = (Math.min(frames - 1, impI + 1) - Math.max(0, impI - 1)) / fps;
    peakSpeed = span > 0 ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / span : 0;
    // IK error of the striker at reach (retarget targets are in the track frame, errors are frame-free).
    const side = seg.striker!.endsWith('_l') ? 0 : 3;
    const k = k0 + reachI;
    const [tgt, got] = seg.striker!.startsWith('fist') ? [r.fistTarget, r.fist] : [r.ankleTarget, r.ankle];
    const o = k * 6 + side;
    strikerErr = Math.hypot(tgt[o] - got[o], tgt[o + 1] - got[o + 1], tgt[o + 2] - got[o + 2]);
  }

  // Joint speed at 1× (lightly smoothed finite differences) → the time-scale limit.
  const jointPeak = new Float64Array(nj);
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < frames; i++) {
      const a = Math.max(0, i - SPEED_SMOOTH), b = Math.min(frames - 1, i + SPEED_SMOOTH);
      if (a === b) continue;
      const v = Math.abs(q[b * nj + j] - q[a * nj + j]) * fps / (b - a);
      if (v > jointPeak[j]) jointPeak[j] = v;
    }
  }
  let maxSpeed = MAX_SPEED_CAP;
  let slowest = '';
  for (let j = 0; j < nj; j++) {
    if (jointPeak[j] < 1e-6) continue;
    const s = (SPEED_MARGIN * speedLimit[j]) / jointPeak[j];
    if (s < maxSpeed) {
      maxSpeed = s;
      slowest = m.joints[j].name;
    }
  }
  maxSpeed = Math.max(MIN_SPEED_CAP, maxSpeed);

  let atLimit = 0;
  for (let i = 0; i < frames; i++) {
    for (let j = 0; j < nj; j++) {
      const v = q[i * nj + j], J = m.joints[j];
      if (v - J.lo < AT_LIMIT_RAD || J.hi - v < AT_LIMIT_RAD) atLimit++;
    }
  }
  let trunkDrop = 0;
  for (let i = 0; i < frames; i++) trunkDrop = Math.max(trunkDrop, Math.abs(r.trunkDrop[k0 + i]));
  const quality: MoveQuality = {
    fistErr: round4(meanDist(r.fistTarget, r.fist, k0, frames)),
    footErr: round4(meanDist(r.ankleTarget, r.ankle, k0, frames)),
    limitRate: round4(atLimit / (frames * nj)),
  };
  const last = (frames - 1) * 7;
  const travel: Vec3 = [round4(root[last]), round4(root[last + 1]), round4(root[last + 2] - root[2])];
  const phase = (x: number) => Math.min(frames - 1, Math.max(0, x - seg.start));
  const json: MoveJson = {
    id: seg.id, label: seg.label, side: seg.side, striker: seg.striker, height: seg.height, loop: seg.loop, frames,
    phases: [phase(seg.strike), Math.max(phase(seg.strike), phase(seg.recover))],
    impact: seg.impact === null ? null : phase(seg.impact),
    reach: seg.reach === null ? null : phase(seg.reach),
    target, peakSpeed: round4(peakSpeed), travel, maxSpeed: round4(maxSpeed), quality,
    source: {
      clip: seg.clip, start: seg.start, end: seg.start + frames, mirrored: seg.mirrored,
      scale: round4(r.scale.leg), lift: round4(r.scale.lift),
      align: { yaw: round4(yaw), x: round4(x0), y: round4(y0) },
    },
    q: encodeAngles(q), root: encodeRoot(root), contacts: encodeBytes(contacts),
  };
  return {
    json, q, root, contacts,
    metrics: {
      fistErr: quality.fistErr, footErr: quality.footErr,
      kneeErr: meanDist(r.kneeTarget, r.knee, k0, frames), elbowErr: meanDist(r.elbowTarget, r.elbow, k0, frames),
      strikerErr, limitRate: quality.limitRate, jointPeak, slowest, trunkDrop,
    },
  };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

