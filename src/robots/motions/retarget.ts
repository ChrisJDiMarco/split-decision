// Human track → robot joint angles, for any biped RobotDesign.
//
// Three passes over the frames:
//   A. Trunk. Root: the actor's hip centre scaled by the leg-length ratio, lifted so a flat human
//      foot puts the robot's sole on the floor; pelvis attitude copied from the actor. Waist and
//      neck by orientation matching (torso forward/up axes to the actor's chest, head forward to
//      the actor's head) over whatever joints the design has there. Then the trunk meets the mat:
//      where the actor's hips or chest rest on the floor the robot's trunk is lowered onto it,
//      and a bulkier robot is never left inside it (smoothed, so contact edges don't pop).
//   B. Targets. Arms: the actor's fist relative to the shoulder line, stretched per axis so a fist
//      on the centre line stays on the robot's centre line and a guard clears its (deeper) chest,
//      but never straighter than the actor's own arm; the elbow from two-link IK with the actor's
//      elbow as pole. Legs: ankle target scaled like the root, offset by the hip-width
//      difference, knee from two-link IK with the actor's knee as pole, sole attitude from the
//      actor's foot. Contacts pin targets: planted feet lock to one spot (ball of the foot),
//      hands the actor put down press flat on the mat at one spot, kneeling knees likewise.
//   C. Limb IK: damped least squares per limb within joint limits and above the floor.
import type { Vec3 } from '../../core/types';
import { CONTACT, humanContacts, runs } from './contacts';
import { fr, pt, SIDES, sideSign, type HumanTrack, type Side } from './human';
import { makeChain, solveChain, solveChainRobust, type Chain, type Task } from './ik';
import {
  add, clamp, col, cross, dot, fromColumns, mulMM, mulMtV, mulMV, norm, normalize, rotY, rotZ, scale, smooth, sub, type Mat3,
} from './math';
import { bodyLowestZ, fkBody, geomExtremes, newFrames, type BodyFrames, type Limb, type RobotModel } from './robot-model';

export interface RetargetOptions {
  from?: number; // first track frame (default 0)
  to?: number; // end track frame, exclusive (default track.n)
  footLock?: boolean; // default true
  /** Pin hands, knees and the trunk to the floor where the actor touched it (default true). */
  contactLock?: boolean;
  /** Re-aim a strike: raise or lower one ankle's path (e.g. a body roundhouse → a low kick). */
  adjust?: readonly StrikeAdjust[];
}

/**
 * Height change of one foot's path over track frames [from, to], full at `peak` and eased to
 * nothing at both ends (sin² bump). `dz` is in the actor's metres; the robot gets dz × leg scale.
 */
export interface StrikeAdjust {
  side: Side;
  from: number;
  peak: number;
  to: number;
  dz: number;
}

/** Weight of an adjust at track frame i (0 outside, 1 at the peak). */
export function adjustWeight(a: StrikeAdjust, i: number): number {
  if (i <= a.from || i >= a.to) return 0;
  const u = i < a.peak ? (i - a.from) / Math.max(1, a.peak - a.from) : (a.to - i) / Math.max(1, a.to - a.peak);
  return Math.sin((Math.PI / 2) * Math.min(1, u)) ** 2;
}

export interface Retargeted {
  model: RobotModel;
  fps: number;
  n: number;
  from: number; // track frame of output frame 0
  q: Float64Array; // n × joints, radians, indexed like model.joints
  rootPos: Float64Array; // n × 3, world metres (the track's floor frame)
  rootRot: Float64Array; // n × 9
  contacts: Uint8Array; // n, CONTACT flags from the actor
  /** Requested targets and what the solved pose reached, n × 2 sides × 3. */
  fistTarget: Float64Array;
  fist: Float64Array;
  ankleTarget: Float64Array;
  ankle: Float64Array;
  elbowTarget: Float64Array;
  elbow: Float64Array;
  kneeTarget: Float64Array;
  knee: Float64Array;
  /** Trunk height correction applied to the root (m, + lifts): the mat pass of step A. */
  trunkDrop: Float64Array;
  /** Frames each joint spent on a range limit (indexed like model.joints). */
  atLimit: Uint32Array;
  /** Limb-frames eased across by the jump repair (IK branch flips smoothed over). */
  repaired: number;
  /** Arm targets further than the arm reaches, frames × arms. */
  armOutOfReach: number;
  scale: { leg: number; arm: number; lift: number };
}

const REACH_MARGIN = 0.995;
const MIN_FOLD = 2.6; // rad: tightest elbow / knee the two-link solution will ask for
const LOCK_BLEND = 4; // frames to blend into and out of a contact lock
const HUMAN_CHEST_FRONT_PER_LEG = 0.11; // actor's chest face ahead of the shoulder line, × leg length
const HUMAN_FIST_HALF_PER_LEG = 0.05;
const AT_LIMIT_RAD = 2e-3;
const RESTART_ABOVE = 0.03; // weighted residual (≈ m) that triggers IK restarts from the seeds
const EXTENSION_SLACK = 0.03; // the robot arm may straighten this much past the actor's (fraction)
const MIN_ARM_EXTENSION = 0.3; // never pull a fist target closer than this × arm length
const TRUNK_SMOOTH = 13; // frames: the trunk-on-the-mat correction is smoothed over this window
const TRUNK_BITS = CONTACT.HIPS | CONTACT.CHEST;
const ARM_POSTURE_W = 0.02; // per radian away from the stance, vs 1 per metre of fist error
const ARM_STEADY_W = 0.06; // per radian of change from the previous frame
const LEG_STEADY_W = 0.03;
const JUMP_RAD_S = 21; // rad/s in one frame: a step this sudden is a flip unless the targets moved too
const FLIP_TRAVEL_PER_RAD = 0.2; // m of target travel per rad of joint step that makes a step genuine
const FLIP_STEP_MAX = 0.5; // rad/frame: above twice this a step is a flip whatever the targets did
const JUMP_WINDOW_S = 0.1; // eased on each side of a jump

/** Monotone piecewise map: [0, edgeH] stretches to [0, edgeR], beyond it slope k. */
function stretch(x: number, edgeH: number, edgeR: number, k: number): number {
  if (x <= 0) return x * k;
  if (x <= edgeH) return (x * edgeR) / edgeH;
  return edgeR + (x - edgeH) * k;
}

/** Unit vector perpendicular to `u`, leaning toward `pole` (null when the pole is ~parallel). */
function swivel(u: Vec3, pole: Vec3): Vec3 | null {
  const w = sub(pole, scale(u, dot(pole, u)));
  const n = norm(w);
  return n > 1e-4 ? scale(w, 1 / n) : null;
}

/** Middle joint of a two-link chain from `root` toward `end`, bending toward `w` (⊥ to the line). */
function midJoint(root: Vec3, end: Vec3, a: number, b: number, w: Vec3): Vec3 {
  const t = sub(end, root);
  const dMin = Math.sqrt(Math.max(1e-6, a * a + b * b + 2 * a * b * Math.cos(MIN_FOLD)));
  const d = clamp(norm(t), dMin, (a + b) * REACH_MARGIN);
  const u = normalize(t, [0, 0, -1]);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  return add(root, add(scale(u, a * cosA), scale(w, a * sinA)));
}

function medianOf(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

interface LimbSolver {
  limb: Limb;
  chain: Chain;
  floor: Task[];
  posture: Task[]; // weak pull toward the design stance: picks the natural branch near singularities
  seeds: number[][]; // restart angles per chain joint: the design stance, then all zero
}

function floorTasks(m: RobotModel, bodies: number[], w: number): Task[] {
  const out: Task[] = [];
  for (const b of bodies) {
    for (const g of m.bodies[b].part.geoms) {
      for (const e of geomExtremes(g)) out.push({ kind: 'floor', body: b, local: e.p, radius: e.r, minZ: 0, w });
    }
  }
  return out;
}

/** Heading-only attitude with an optional heel lift: Rz(yaw)·Ry(pitch). */
function plantedAttitude(R: Mat3): Mat3 {
  const x = col(R, 0);
  const yaw = Math.atan2(x[1], x[0]);
  const pitch = Math.max(0, Math.atan2(-x[2], Math.hypot(x[0], x[1]))); // heel up only
  return mulMM(rotZ(yaw), rotY(pitch));
}

/** Blend two attitudes by their x and z axes (w = 0 → a, 1 → b). */
function blendAttitude(a: Mat3, b: Mat3, w: number): Mat3 {
  const x = normalize(add(scale(col(a, 0), 1 - w), scale(col(b, 0), w)));
  const z0 = add(scale(col(a, 2), 1 - w), scale(col(b, 2), w));
  const y = normalize(cross(z0, x), [0, 1, 0]);
  return fromColumns(x, y, cross(x, y));
}

/** Weight of a contact lock at frame i for a run [rs, re) with LOCK_BLEND ramps on both sides. */
function lockWeight(i: number, rs: number, re: number): number {
  if (i < rs) return (i - (rs - LOCK_BLEND) + 1) / (LOCK_BLEND + 1);
  if (i >= re) return (re + LOCK_BLEND - i) / (LOCK_BLEND + 1);
  return 1;
}

/**
 * Pin a per-frame target track (n × 3) to one floor spot during each contact run: x, y to the run's
 * median, z to `restZ`; blended in and out over LOCK_BLEND frames.
 */
function lockToFloor(target: Vec3[], flags: Uint8Array, bit: number, restZ: number): boolean[] {
  const n = target.length;
  const locked = new Array<boolean>(n).fill(false);
  for (const [rs, re] of runs(flags, bit)) {
    const lock: Vec3 = [medianOf(target.slice(rs, re).map((p) => p[0])), medianOf(target.slice(rs, re).map((p) => p[1])), restZ];
    for (let i = Math.max(0, rs - LOCK_BLEND); i < Math.min(n, re + LOCK_BLEND); i++) {
      const w = clamp(lockWeight(i, rs, re), 0, 1);
      target[i] = add(scale(target[i], 1 - w), scale(lock, w));
      if (i >= rs && i < re) locked[i] = true;
    }
  }
  return locked;
}

export function retarget(tr: HumanTrack, m: RobotModel, opts: RetargetOptions = {}): Retargeted {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(tr.n, opts.to ?? tr.n);
  const n = Math.max(0, to - from);
  const nj = m.joints.length;
  const d = m.dims, h = tr.dims;
  const kLeg = d.legLength / h.legLength;
  const kArm = d.armLength / h.armLength;
  const lift = d.soleDepth - kLeg * h.ankleHeight;
  const chestFrontH = HUMAN_CHEST_FRONT_PER_LEG * h.legLength;
  const fistExtra = Math.max(0, d.fistHalf - HUMAN_FIST_HALF_PER_LEG * h.legLength);
  const contactLock = opts.contactLock !== false;

  const out: Retargeted = {
    model: m, fps: tr.fps, n, from,
    q: new Float64Array(n * nj), rootPos: new Float64Array(n * 3), rootRot: new Float64Array(n * 9),
    contacts: humanContacts(tr).slice(from, to),
    fistTarget: new Float64Array(n * 6), fist: new Float64Array(n * 6),
    ankleTarget: new Float64Array(n * 6), ankle: new Float64Array(n * 6),
    elbowTarget: new Float64Array(n * 6), elbow: new Float64Array(n * 6),
    kneeTarget: new Float64Array(n * 6), knee: new Float64Array(n * 6),
    trunkDrop: new Float64Array(n),
    atLimit: new Uint32Array(nj), repaired: 0, armOutOfReach: 0,
    scale: { leg: kLeg, arm: kArm, lift },
  };
  if (n === 0) return out;

  const f: BodyFrames = newFrames(m);
  const q = new Float64Array(nj);
  for (const [name, v] of Object.entries(m.design.stance)) {
    const ji = m.jointIndex.get(name);
    if (ji !== undefined) q[ji] = clamp(v, m.joints[ji].solveLo, m.joints[ji].solveHi);
  }
  const pathTo = (a: number, b: number) => {
    const p: number[] = [];
    for (let x = b; x !== a && x >= 0; x = m.bodies[x].parent) p.unshift(x);
    return p;
  };
  const waist = makeChain(m, pathTo(m.pelvis, m.torso));
  const neck = makeChain(m, pathTo(m.torso, m.head));
  const trunkJoints = [...waist.joints, ...neck.joints];
  const coreBodies = [m.pelvis, ...waist.bodies, ...neck.bodies];
  // Chains start at the trunk so any intermediate bodies (a clavicle, say) are solved too.
  const limbSolver = (limb: Limb, trunk: number): LimbSolver => {
    const chain = makeChain(m, pathTo(trunk, limb.bodies[2]));
    const stance = chain.joints.map((j) => clamp(m.design.stance[m.joints[j].name] ?? 0, m.joints[j].solveLo, m.joints[j].solveHi));
    const zero = chain.joints.map((j) => clamp(0, m.joints[j].solveLo, m.joints[j].solveHi));
    const posture: Task[] = limb.kind === 'arm' ? chain.joints.map((j, k) => ({ kind: 'joint', joint: j, target: stance[k], w: ARM_POSTURE_W })) : [];
    return { limb, chain, floor: floorTasks(m, chain.bodies, 4), posture, seeds: [stance, zero] };
  };
  const arms = { l: limbSolver(m.arms.l, m.torso), r: limbSolver(m.arms.r, m.torso) };
  const legs = { l: limbSolver(m.legs.l, m.pelvis), r: limbSolver(m.legs.r, m.pelvis) };
  const hipOffset = d.hipCenter;

  // ---------------------------------------------------------------- A. trunk
  const low = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = from + k;
    const P = fr(tr, 'pelvis', i);
    const hip = scale(pt(tr, 'hipC', i), kLeg);
    hip[2] += lift;
    const rootPos = sub(hip, mulMV(P, hipOffset));
    f.pos[m.pelvis] = rootPos;
    f.rot[m.pelvis] = P;
    const C = fr(tr, 'chest', i);
    solveChain(m, waist, f, q, [
      { kind: 'dir', body: m.torso, local: [1, 0, 0], target: col(C, 0), w: 1 },
      { kind: 'dir', body: m.torso, local: [0, 0, 1], target: col(C, 2), w: 1 },
    ], { iterations: 12, tol: 1e-4 });
    const Hd = fr(tr, 'head', i);
    solveChain(m, neck, f, q, [{ kind: 'dir', body: m.head, local: [1, 0, 0], target: col(Hd, 0), w: 1 }], { iterations: 8, tol: 1e-4 });
    let lo = Infinity;
    for (const b of coreBodies) lo = Math.min(lo, bodyLowestZ(m, f, b));
    low[k] = lo;
    out.rootPos.set(rootPos, k * 3);
    out.rootRot.set(P, k * 9);
    for (const j of trunkJoints) out.q[k * nj + j] = q[j];
  }
  {
    // Onto the mat where the actor lay on it, out of it everywhere.
    const raw = new Float64Array(n);
    for (let k = 0; k < n; k++) raw[k] = contactLock && out.contacts[k] & TRUNK_BITS ? -low[k] : Math.max(0, -low[k]);
    const sm = smooth(raw, TRUNK_SMOOTH);
    for (let k = 0; k < n; k++) {
      out.trunkDrop[k] = Math.max(sm[k], -low[k]);
      out.rootPos[k * 3 + 2] += out.trunkDrop[k];
    }
  }
  /** Pose the trunk bodies of output frame k (root + waist + neck from pass A). */
  const poseTrunk = (k: number) => {
    f.pos[m.pelvis] = [out.rootPos[k * 3], out.rootPos[k * 3 + 1], out.rootPos[k * 3 + 2]];
    f.rot[m.pelvis] = Array.from(out.rootRot.subarray(k * 9, k * 9 + 9)) as Mat3;
    for (const j of trunkJoints) q[j] = out.q[k * nj + j];
    for (const b of [...waist.bodies, ...neck.bodies]) fkBody(m, b, q, f);
  };

  // ---------------------------------------------------------------- B. targets
  // The actor's shoulder line, fixed in the chest frame (clavicles shrug; the robot's don't).
  const shoulderMid: Vec3 = [0, 0, 0];
  {
    const xs: number[][] = [[], [], []];
    for (let i = from; i < to; i++) {
      const c = fr(tr, 'chest', i);
      const mid = scale(add(pt(tr, 'shoulderL', i), pt(tr, 'shoulderR', i)), 0.5);
      const v = mulMtV(c, sub(mid, pt(tr, 'chest', i)));
      for (let k = 0; k < 3; k++) xs[k].push(v[k]);
    }
    for (let k = 0; k < 3; k++) shoulderMid[k] = medianOf(xs[k]);
  }
  type ArmTargets = { fist: Vec3[]; pole: Vec3[]; shoulder: Vec3[]; handDown: boolean[] };
  type LegTargets = { ankle: Vec3[]; rot: Mat3[]; pole: Vec3[]; hip: Vec3[]; knee: Vec3[]; planted: boolean[]; kneeDown: boolean[] };
  const armT: Record<Side, ArmTargets> = {
    l: { fist: [], pole: [], shoulder: [], handDown: [] },
    r: { fist: [], pole: [], shoulder: [], handDown: [] },
  };
  const legT: Record<Side, LegTargets> = {
    l: { ankle: [], rot: [], pole: [], hip: [], knee: [], planted: [], kneeDown: [] },
    r: { ankle: [], rot: [], pole: [], hip: [], knee: [], planted: [], kneeDown: [] },
  };
  const prevArmPole: Record<Side, Vec3> = { l: [-0.3, 0.3, -1], r: [-0.3, -0.3, -1] }; // torso frame
  for (let k = 0; k < n; k++) {
    const i = from + k;
    poseTrunk(k);
    const T = f.rot[m.torso];
    const C = fr(tr, 'chest', i);
    const shoulderMidR = add(f.pos[m.torso], mulMV(T, d.shoulderCenter));
    const shoulderMidH = add(pt(tr, 'chest', i), mulMV(C, shoulderMid));
    for (const s of SIDES) {
      const S = s === 'l' ? 'L' : 'R';
      const sol = arms[s];
      const rel = (id: 'fistL' | 'fistR' | 'elbowL' | 'elbowR' | 'shoulderL' | 'shoulderR') => mulMtV(C, sub(pt(tr, id, i), shoulderMidH));
      const fh = rel(`fist${S}`), eh = rel(`elbow${S}`), sh = rel(`shoulder${S}`);
      const fx = stretch(fh[0], chestFrontH, d.chestFront + fistExtra, kArm);
      const fy = Math.sign(fh[1]) * stretch(Math.abs(fh[1]), h.shoulderHalfWidth, d.shoulderHalfWidth, kArm);
      let fistT = add(shoulderMidR, mulMV(T, [fx, fy, fh[2] * kArm]));
      for (const b of pathTo(m.torso, sol.limb.bodies[0])) fkBody(m, b, q, f);
      const shoulderW = f.pos[sol.limb.bodies[0]];
      // Never straighter than the actor's own arm: a fully extended actor arm maps to a fully
      // extended robot arm, a bent one stays bent (the stretch alone overshoots near full reach).
      const reach = sol.limb.upper + sol.limb.lower;
      const extH = norm(sub(fh, sh)) / h.armLength;
      const dT = sub(fistT, shoulderW);
      const dl = norm(dT);
      const maxD = clamp(extH + EXTENSION_SLACK, MIN_ARM_EXTENSION, 1) * reach;
      if (dl > maxD) fistT = add(shoulderW, scale(dT, maxD / dl));
      // Elbow pole: the actor's elbow off its shoulder→fist line, carried in the chest frame.
      const uh = normalize(sub(fh, sh));
      const poleH = sub(sub(eh, sh), scale(uh, dot(sub(eh, sh), uh)));
      if (norm(poleH) > 0.02 * h.legLength) prevArmPole[s] = normalize(poleH);
      armT[s].fist.push(fistT);
      armT[s].pole.push(mulMV(T, prevArmPole[s]));
      armT[s].shoulder.push(shoulderW);
    }
  }
  for (const s of SIDES) {
    const bit = s === 'l' ? CONTACT.HAND_L : CONTACT.HAND_R;
    armT[s].handDown = contactLock ? lockToFloor(armT[s].fist, out.contacts, bit, d.fistHalf) : new Array<boolean>(n).fill(false);
  }

  const ballLocal: Vec3 = [d.footCenterX + 0.6 * d.footHalf[0], 0, -d.soleDepth];
  for (const s of SIDES) {
    const S = s === 'l' ? 'L' : 'R';
    const widen = (d.hipHalfWidth - kLeg * h.hipHalfWidth) * sideSign(s);
    const T = legT[s];
    for (let k = 0; k < n; k++) {
      const i = from + k;
      const P = fr(tr, 'pelvis', i);
      const lat = normalize([P[1], P[4], 0], [0, 1, 0]);
      const a = scale(pt(tr, `ankle${S}`, i), kLeg);
      let dz = 0;
      for (const adj of opts.adjust ?? []) if (adj.side === s) dz += kLeg * adj.dz * adjustWeight(adj, i);
      T.ankle.push([a[0] + lat[0] * widen, a[1] + lat[1] * widen, a[2] + lift + dz]);
      T.rot.push(fr(tr, `foot${S}`, i));
      T.planted.push(false);
    }
    if (opts.footLock === false) continue;
    const bit = s === 'l' ? CONTACT.FOOT_L : CONTACT.FOOT_R;
    for (const [rs, re] of runs(out.contacts, bit)) {
      const bx: number[] = [], by: number[] = [];
      for (let k = rs; k < re; k++) {
        const ball = add(T.ankle[k], mulMV(plantedAttitude(T.rot[k]), ballLocal));
        bx.push(ball[0]);
        by.push(ball[1]);
      }
      const lock: Vec3 = [medianOf(bx), medianOf(by), 0];
      for (let k = Math.max(0, rs - LOCK_BLEND); k < Math.min(n, re + LOCK_BLEND); k++) {
        const w = clamp(lockWeight(k, rs, re), 0, 1);
        const R = plantedAttitude(T.rot[k]);
        const locked = sub(lock, mulMV(R, ballLocal));
        T.ankle[k] = add(scale(T.ankle[k], 1 - w), scale(locked, w));
        T.rot[k] = w >= 1 ? R : blendAttitude(T.rot[k], R, w);
        if (k >= rs && k < re) T.planted[k] = true;
      }
    }
  }
  // Knee targets need the hips (trunk pose) and the final ankle targets.
  for (let k = 0; k < n; k++) {
    const i = from + k;
    poseTrunk(k);
    const P = f.rot[m.pelvis];
    for (const s of SIDES) {
      const S = s === 'l' ? 'L' : 'R';
      const sol = legs[s];
      for (const b of pathTo(m.pelvis, sol.limb.bodies[0])) fkBody(m, b, q, f);
      const hipW = f.pos[sol.limb.bodies[0]];
      const ah = pt(tr, `ankle${S}`, i), kh = pt(tr, `knee${S}`, i), hh = pt(tr, `hip${S}`, i);
      const uh = normalize(sub(ah, hh));
      const poleH = sub(sub(kh, hh), scale(uh, dot(sub(kh, hh), uh)));
      const u = normalize(sub(legT[s].ankle[k], hipW));
      const w = swivel(u, poleH) ?? swivel(u, col(P, 0)) ?? [1, 0, 0];
      legT[s].hip.push(hipW);
      legT[s].pole.push(w);
      legT[s].knee.push(midJoint(hipW, legT[s].ankle[k], sol.limb.upper, sol.limb.lower, w));
    }
  }
  for (const s of SIDES) {
    const bit = s === 'l' ? CONTACT.KNEE_L : CONTACT.KNEE_R;
    legT[s].kneeDown = contactLock ? lockToFloor(legT[s].knee, out.contacts, bit, d.kneeRadius) : new Array<boolean>(n).fill(false);
  }

  // ---------------------------------------------------------------- C. limb IK
  // Warm start: the stance (or whatever pass A left in q for the trunk). Every limb joint is also
  // pulled weakly toward its value one frame earlier: where the pose leaves a joint free (the twist
  // of a straight arm) it holds still instead of drifting and then whipping around.
  const steady = (chain: Chain, w: number): Task[] => chain.joints.map((j) => ({ kind: 'joint', joint: j, target: q[j], w }));
  for (let k = 0; k < n; k++) {
    poseTrunk(k);
    for (const s of SIDES) {
      const sol = arms[s];
      const A = armT[s];
      const fistT = A.fist[k];
      const shoulderW = A.shoulder[k];
      const u = normalize(sub(fistT, shoulderW));
      const w = swivel(u, A.pole[k]) ?? swivel(u, mulMV(f.rot[m.torso], [0, 0, -1])) ?? [0, 0, -1];
      if (norm(sub(fistT, shoulderW)) > (sol.limb.upper + sol.limb.lower) * REACH_MARGIN) out.armOutOfReach++;
      const elbowT = midJoint(shoulderW, fistT, sol.limb.upper, sol.limb.lower, w);
      solveChainRobust(m, sol.chain, f, q, [
        { kind: 'pos', body: sol.limb.bodies[2], local: [0, 0, 0], target: fistT, w: A.handDown[k] ? 2 : 1 },
        { kind: 'pos', body: sol.limb.bodies[1], local: [0, 0, 0], target: elbowT, w: 0.5 },
        ...sol.floor,
        ...sol.posture,
        ...(k > 0 ? steady(sol.chain, ARM_STEADY_W) : []),
      ], sol.seeds, RESTART_ABOVE);
      const o = k * 6 + (s === 'l' ? 0 : 3);
      out.fistTarget.set(fistT, o);
      out.elbowTarget.set(elbowT, o);
      out.fist.set(f.pos[sol.limb.bodies[2]], o);
      out.elbow.set(f.pos[sol.limb.bodies[1]], o);
    }
    for (const s of SIDES) {
      const sol = legs[s];
      const L = legT[s];
      const planted = L.planted[k];
      solveChainRobust(m, sol.chain, f, q, [
        { kind: 'pos', body: sol.limb.bodies[2], local: [0, 0, 0], target: L.ankle[k], w: 1 },
        { kind: 'pos', body: sol.limb.bodies[1], local: [0, 0, 0], target: L.knee[k], w: L.kneeDown[k] ? 1 : 0.4 },
        { kind: 'dir', body: sol.limb.bodies[2], local: [0, 0, 1], target: col(L.rot[k], 2), w: planted ? 0.8 : 0.5 },
        { kind: 'dir', body: sol.limb.bodies[2], local: [1, 0, 0], target: col(L.rot[k], 0), w: planted ? 0.4 : 0.25 },
        ...sol.floor,
        ...(k > 0 ? steady(sol.chain, LEG_STEADY_W) : []),
      ], sol.seeds, RESTART_ABOVE);
      const o = k * 6 + (s === 'l' ? 0 : 3);
      out.ankleTarget.set(L.ankle[k], o);
      out.kneeTarget.set(L.knee[k], o);
      out.ankle.set(f.pos[sol.limb.bodies[2]], o);
      out.knee.set(f.pos[sol.limb.bodies[1]], o);
    }
    for (let j = 0; j < nj; j++) if (!trunkJoints.includes(j)) out.q[k * nj + j] = q[j];
  }

  // ---------------------------------------------------------------- D. jump repair
  // Where a limb still jumps to another IK branch between two frames (faster than any joint can
  // turn), ease it across over a short window instead: the pose strays briefly, the servo can follow.
  type Reached = { chain: Chain; out: Float64Array; mid: Float64Array; endT: Float64Array; midT: Float64Array; end: number; midBody: number; o: number };
  const reached: Reached[] = [];
  for (const s of SIDES) {
    const o = s === 'l' ? 0 : 3;
    reached.push({ chain: arms[s].chain, out: out.fist, mid: out.elbow, endT: out.fistTarget, midT: out.elbowTarget, end: m.arms[s].bodies[2], midBody: m.arms[s].bodies[1], o });
    reached.push({ chain: legs[s].chain, out: out.ankle, mid: out.knee, endT: out.ankleTarget, midT: out.kneeTarget, end: m.legs[s].bodies[2], midBody: m.legs[s].bodies[1], o });
  }
  for (const R of reached) {
    // Target travel per frame: a real snap moves the fist (or foot) with the joints; a branch flip
    // turns joints while the targets stay put.
    const travel = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      const d = (arr: Float64Array) => Math.hypot(arr[k * 6 + R.o] - arr[(k - 1) * 6 + R.o], arr[k * 6 + R.o + 1] - arr[(k - 1) * 6 + R.o + 1], arr[k * 6 + R.o + 2] - arr[(k - 1) * 6 + R.o + 2]);
      travel[k] = d(R.endT) + d(R.midT);
    }
    for (const [a, b] of jumpWindows(out.q, nj, n, R.chain.joints, JUMP_RAD_S / tr.fps, Math.max(2, Math.round(JUMP_WINDOW_S * tr.fps)), travel)) {
      const k0 = Math.max(0, a - 1), k1 = Math.min(n - 1, b + 1);
      for (let k = a; k <= b; k++) {
        const w = smoothstep01((k - k0) / Math.max(1, k1 - k0));
        for (const j of R.chain.joints) out.q[k * nj + j] = out.q[k0 * nj + j] + (out.q[k1 * nj + j] - out.q[k0 * nj + j]) * w;
        poseTrunk(k);
        for (const j of R.chain.joints) q[j] = out.q[k * nj + j];
        for (const body of R.chain.bodies) fkBody(m, body, q, f);
        R.out.set(f.pos[R.end], k * 6 + R.o);
        R.mid.set(f.pos[R.midBody], k * 6 + R.o);
      }
      out.repaired += b - a + 1;
    }
  }
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < nj; j++) {
      const J = m.joints[j];
      const v = out.q[k * nj + j];
      if (v - J.lo < AT_LIMIT_RAD || J.hi - v < AT_LIMIT_RAD) out.atLimit[j]++;
    }
  }
  return out;
}

const smoothstep01 = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Frame windows [a, b] (inclusive, merged) around IK branch flips of a chain: a joint steps more
 * than `maxStep` in one frame while the chain's targets moved less than FLIP_TRAVEL_PER_RAD × step
 * (metres per radian: a genuine snap carries the fist or foot with it).
 */
export function jumpWindows(
  q: Float64Array, nj: number, n: number, joints: readonly number[], maxStep: number, window: number, targetTravel?: ArrayLike<number>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 1; k < n; k++) {
    let jump = 0;
    for (const j of joints) jump = Math.max(jump, Math.abs(q[k * nj + j] - q[(k - 1) * nj + j]));
    if (jump <= maxStep) continue;
    if (targetTravel && jump <= 2 * FLIP_STEP_MAX && targetTravel[k] > FLIP_TRAVEL_PER_RAD * jump) continue;
    const a = Math.max(0, k - window), b = Math.min(n - 1, k + window - 1);
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- error summaries

export interface ErrorStats {
  mean: number;
  p95: number;
  max: number;
}

/** Distance between requested and reached points (n × 2 sides × 3), over all or some frames. */
export function errorStats(target: Float64Array, got: Float64Array, frames?: ArrayLike<number>): ErrorStats {
  const e: number[] = [];
  const count = target.length / 3;
  const use = frames ?? Array.from({ length: count / 2 }, (_, i) => i);
  for (let u = 0; u < use.length; u++) {
    const k = use[u];
    for (let s = 0; s < 2; s++) {
      const o = (k * 2 + s) * 3;
      e.push(Math.hypot(target[o] - got[o], target[o + 1] - got[o + 1], target[o + 2] - got[o + 2]));
    }
  }
  if (!e.length) return { mean: 0, p95: 0, max: 0 };
  e.sort((a, b) => a - b);
  return { mean: e.reduce((a, b) => a + b, 0) / e.length, p95: e[Math.floor(e.length * 0.95)], max: e[e.length - 1] };
}
