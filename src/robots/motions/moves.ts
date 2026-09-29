// Segment + retargeted clip → one library move: frames sliced, re-expressed in the move frame
// (x toward the opponent, pelvis starting over the origin), loops closed, and the numbers the
// tracking controller plans with (strike target, peak speed, travel, time-scale limit, quality).
import type { Quat, Vec3 } from '../../core/types';
import { encodeAngles, encodeBytes, encodeRoot } from './codec';
import { matFromQuat, mulMM, mulMV, quatFromMat, quatSlerp, rotZ, type Mat3 } from './math';
import { CONTACT, runs } from './contacts';
import { bodyLowestZ, bodyPoint, fk, newFrames, type RobotModel } from './robot-model';
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
  strikerPathErr: number; // striker: worst requested vs reached over the strike phase, m
  limitRate: number;
  jointPeak: Float64Array; // rad/s at 1×, per joint
  slowest: string; // joint that caps maxSpeed
  trunkDrop: number; // max |trunk mat correction|, m
  sink: number; // deepest collision point below the mat over the move, m
  lookAway: [number, number]; // head heading off +x at the first and at the last frame, rad
  lookAtImpact: number; // head heading off +x where the striker lands, rad (0 without a striker)
  footSlide: number; // worst drift of a planted foot (ball) within one contact run, m
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

/** Strikes that land mid-arc (at impact) rather than at full reach. A jumping knee lands at the
 * top of its drive (its impact frame), not at "full reach" (a knee is always a thigh from the hip). */
export const ARC_LABELS = new Set(['hook', 'overhand', 'low_kick', 'head_kick', 'tornado_kick', 'spinning_backfist', 'jumping_knee']);
/** Arcs that sweep across onto the opponent's centre line (an uppercut rises under the chin from
 * where it is; a low kick goes for the lead thigh). */
const MIDLINE_ARCS = new Set(['hook', 'overhand', 'head_kick', 'tornado_kick', 'spinning_backfist']);
const HEAD_HALF_WIDTH_M = 0.1;
/** m: one foot this far ahead of the other is a stance (orthodox or southpaw), less is square. */
const STANCE_LEAD_M = 0.08;

/** Labels whose loops travel: walks and sideways-walk shuffles. */
export const isLocomotion = (label: string): boolean => label.startsWith('walk') || label.startsWith('shuffle');

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
  // Locomotion loops keep their stride (the sampler accumulates it per cycle); a guard loop stays put.
  if (seg.loop) closeLoop(q, root, frames, nj, isLocomotion(seg.label));

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
  let strikerPathErr = 0;
  let contactI: number | null = seg.impact === null ? null : rel(seg.impact);
  if (strikerBody !== null && seg.reach !== null && seg.impact !== null) {
    const reachI = rel(seg.reach);
    let impI = rel(seg.impact);
    // Thrusts land at full extension. Sweeping arcs (hooks, overhands, head kicks) can peak in
    // speed while still out wide and follow through past the target: they land where the arc
    // first comes within a head's width of the line to the opponent (y = 0 in the move frame),
    // or as close to it as it gets.
    if (MIDLINE_ARCS.has(seg.label)) {
      let best = Infinity;
      const from = impI;
      for (let i = from; i <= reachI; i++) {
        const y = Math.abs(strikerAt(i)[1]);
        if (y < best) {
          best = y;
          impI = i;
        }
        if (y <= HEAD_HALF_WIDTH_M) break;
      }
      contactI = impI;
    }
    target = strikerAt(ARC_LABELS.has(seg.label) ? impI : reachI).map((v) => Math.round(v * 1000) / 1000) as Vec3;
    const a = strikerAt(Math.max(0, impI - 1)), b = strikerAt(Math.min(frames - 1, impI + 1));
    const span = (Math.min(frames - 1, impI + 1) - Math.max(0, impI - 1)) / fps;
    peakSpeed = span > 0 ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / span : 0;
    // IK error of the striker at reach (retarget targets are in the track frame, errors are frame-free).
    const side = seg.striker!.endsWith('_l') ? 0 : 3;
    const k = k0 + reachI;
    const [tgt, got] = seg.striker!.startsWith('fist') ? [r.fistTarget, r.fist] : seg.striker!.startsWith('shin') ? [r.kneeTarget, r.knee] : [r.ankleTarget, r.ankle];
    const o = k * 6 + side;
    strikerErr = Math.hypot(tgt[o] - got[o], tgt[o + 1] - got[o + 1], tgt[o + 2] - got[o + 2]);
    // Worst miss along the strike itself: a limb eased across an IK branch flip strays off the
    // actor's path mid-strike even when it arrives at the end.
    for (let i = rel(seg.strike); i <= reachI; i++) {
      const p = (k0 + i) * 6 + side;
      strikerPathErr = Math.max(strikerPathErr, Math.hypot(tgt[p] - got[p], tgt[p + 1] - got[p + 1], tgt[p + 2] - got[p + 2]));
    }
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
  // Deepest any collision geom goes below the mat (the IK keeps limbs out where it can), and how
  // far the head looks away from the opponent (+x) at the first and at the last frame.
  let sink = 0;
  const lookAway: [number, number] = [0, 0];
  let lookAtImpact = 0;
  const lead: [number, number] = [0, 0];
  const d = m.dims;
  const ballLocal: Vec3 = [d.footCenterX + 0.6 * d.footHalf[0], 0, -d.soleDepth];
  const balls: Record<'l' | 'r', Vec3[]> = { l: [], r: [] }; // left ankle ahead of the right (x, m) at the first and last frame
  for (let i = 0; i < frames; i++) {
    const o = i * 7;
    fk(m, [root[o], root[o + 1], root[o + 2]], matFromQuat([root[o + 3], root[o + 4], root[o + 5], root[o + 6]]), q.subarray(i * nj, (i + 1) * nj), f);
    for (let b = 0; b < m.bodies.length; b++) sink = Math.max(sink, -bodyLowestZ(m, f, b));
    if (contactI !== null && i === contactI) {
      const H = f.rot[m.head];
      if (Math.hypot(H[0], H[3]) > 0.3) lookAtImpact = Math.abs(Math.atan2(H[3], H[0]));
    }
    if (i === 0 || i === frames - 1) {
      const H = f.rot[m.head]; // column 0: the head's forward axis
      if (Math.hypot(H[0], H[3]) > 0.3) lookAway[i === 0 ? 0 : 1] = Math.abs(Math.atan2(H[3], H[0]));
      lead[i === 0 ? 0 : 1] = f.pos[m.legs.l.bodies[2]][0] - f.pos[m.legs.r.bodies[2]][0];
    }
    balls.l.push(bodyPoint(f, m.legs.l.bodies[2], ballLocal));
    balls.r.push(bodyPoint(f, m.legs.r.bodies[2], ballLocal));
  }
  // Planted feet: how far the ball of each foot drifts within one of the actor's contact runs.
  let footSlide = 0;
  for (const [side, bit] of [['l', CONTACT.FOOT_L], ['r', CONTACT.FOOT_R]] as const) {
    for (const [a, b] of runs(contacts, bit)) {
      const p0 = balls[side][a];
      for (let i = a; i < b; i++) footSlide = Math.max(footSlide, Math.hypot(balls[side][i][0] - p0[0], balls[side][i][1] - p0[1]));
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
  const flight = flightOf(contacts, root, frames);
  const spin = spinOf(root, frames);
  const phase = (x: number) => Math.min(frames - 1, Math.max(0, x - seg.start));
  const json: MoveJson = {
    id: seg.id, label: seg.label, side: seg.side, striker: seg.striker, height: seg.height, loop: seg.loop, frames,
    phases: [phase(seg.strike), Math.max(phase(seg.strike), phase(seg.recover))],
    impact: contactI,
    reach: seg.reach === null ? null : phase(seg.reach),
    target, peakSpeed: round4(peakSpeed), travel, maxSpeed: round4(maxSpeed),
    switchesStance: Math.abs(lead[0]) > STANCE_LEAD_M && Math.abs(lead[1]) > STANCE_LEAD_M && Math.sign(lead[0]) !== Math.sign(lead[1]),
    ...(flight ? { flight } : {}),
    ...(Math.abs(spin) > MIN_SPIN_RAD ? { spin: round4(spin) } : {}),
    quality,
    source: {
      clip: seg.clip, start: seg.start, end: seg.start + frames, mirrored: seg.mirrored,
      scale: round4(r.scale.leg), lift: round4(r.scale.lift),
      align: { yaw: round4(yaw), x: round4(x0), y: round4(y0) },
      ...(seg.turn ? { turn: { ...seg.turn, angle: round4(seg.turn.angle) } } : {}),
      ...(seg.leap ? { leap: seg.leap } : {}),
    },
    q: encodeAngles(q), root: encodeRoot(root), contacts: encodeBytes(contacts),
  };
  return {
    json, q, root, contacts,
    metrics: {
      fistErr: quality.fistErr, footErr: quality.footErr,
      kneeErr: meanDist(r.kneeTarget, r.knee, k0, frames), elbowErr: meanDist(r.elbowTarget, r.elbow, k0, frames),
      strikerErr, strikerPathErr, limitRate: quality.limitRate, jointPeak, slowest, trunkDrop, sink, lookAway, lookAtImpact, footSlide,
    },
  };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Shortest airborne run worth reporting (frames), and the smallest turn stored as a spin. */
const MIN_FLIGHT_FRAMES = 3;
const MIN_SPIN_RAD = 0.05;

/**
 * The airborne part: the longest run where nothing is on the mat (contact byte 0), as
 * [take-off frame, landing frame, pelvis rise over its take-off height (m)]; null when the move
 * always has something down.
 */
export function flightOf(contacts: Uint8Array, root: Float32Array, frames: number): [number, number, number] | null {
  let best: [number, number] | null = null;
  for (const [a, b] of runs(contacts.map((c) => (c === 0 ? 1 : 0)))) if (!best || b - a > best[1] - best[0]) best = [a, b];
  if (!best || best[1] - best[0] < MIN_FLIGHT_FRAMES) return null;
  let top = -Infinity;
  for (let i = best[0]; i < Math.min(frames, best[1]); i++) top = Math.max(top, root[i * 7 + 2]);
  return [best[0], Math.min(frames - 1, best[1]), round4(Math.max(0, top - root[best[0] * 7 + 2]))];
}

/**
 * Pelvis heading change over the move about the vertical (rad, + counter-clockwise from above),
 * unwrapped. Read off the pelvis's lateral axis, which stays level when the body folds over or
 * goes horizontal in the air.
 */
export function spinOf(root: Float32Array, frames: number): number {
  let total = 0, prev = 0;
  for (let i = 0; i < frames; i++) {
    const o = i * 7;
    const R = matFromQuat([root[o + 3], root[o + 4], root[o + 5], root[o + 6]]);
    const h = Math.atan2(R[4], R[1]) - Math.PI / 2; // column 1 (the pelvis's left) turned back to forward
    if (i > 0) {
      let d = h - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prev = h;
  }
  return total;
}

