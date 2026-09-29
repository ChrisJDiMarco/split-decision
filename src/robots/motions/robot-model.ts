// A RobotDesign read as a kinematic tree for retargeting: bodies, hinge joints (axis, range),
// semantic roles found from part tags, and the proportions the retargeter scales to. Mirrors
// MuJoCo's body chain exactly (see render/robot-kit/fk.ts):
//   R_child = R_parent · R(quat) · Π R(axis_k, q_k),   p_child = p_parent + R_parent · pos
// Nothing here is specific to one design: a biped with differently ordered or extra joints works
// as long as its parts carry the usual tags (pelvis, torso, head, upperarm, forearm, fist,
// thigh, shin, foot + left/right).
import type { GeomDef, PartDef, PartTag, RobotDesign, Vec3 } from '../../core/types';
import { axisAngle, identity, matFromQuat, mulMM, mulMV, normalize, type Mat3 } from './math';
import type { Side } from './human';

export interface ModelJoint {
  name: string;
  index: number;
  body: number;
  slot: number; // position among its body's joints
  axis: Vec3; // unit, in the frame after the body's earlier joints
  lo: number; // radians
  hi: number;
  /**
   * Range the retargeting IK may use. The middle joint of a three-hinge spherical group (shoulder
   * roll, hip roll) stays off ±90°, where the outer two axes line up (gimbal lock): an arm that
   * passes through there flips between IK branches, which no servo can follow.
   */
  solveLo: number;
  solveHi: number;
}

/** Middle joint of a spherical group is kept this far inside ±90° while solving. */
export const GIMBAL_MARGIN_RAD = (6 * Math.PI) / 180;

export interface ModelBody {
  id: string;
  index: number;
  parent: number; // -1 for the root
  pos: Vec3;
  rot: Mat3; // fixed rotation from the part quat
  joints: number[];
  part: PartDef;
}

export type LimbKind = 'arm' | 'leg';

export interface Limb {
  kind: LimbKind;
  side: Side;
  base: number; // body the limb hangs from (torso / pelvis)
  bodies: number[]; // upper, lower, end (e.g. upperarm, forearm, fist)
  joints: number[]; // every joint along the chain, root first
  upper: number; // joint centre → middle joint centre
  lower: number; // middle joint → end point (fist centre / ankle)
}

export interface RobotModel {
  design: RobotDesign;
  bodies: ModelBody[];
  joints: ModelJoint[];
  jointIndex: Map<string, number>;
  bodyIndex: Map<string, number>;
  pelvis: number;
  torso: number;
  head: number;
  waistJoints: number[]; // joints between pelvis and torso
  neckJoints: number[]; // joints between torso and head
  arms: Record<Side, Limb>;
  legs: Record<Side, Limb>;
  dims: RobotDims;
}

export interface RobotDims {
  legLength: number;
  armLength: number;
  hipCenter: Vec3; // midpoint of the hip joints, pelvis frame
  hipHalfWidth: number;
  shoulderCenter: Vec3; // midpoint of the shoulder joints, torso frame
  shoulderHalfWidth: number;
  chestFront: number; // torso armour front face ahead of the shoulder line, torso frame x
  soleDepth: number; // ankle joint → bottom of the sole
  footCenterX: number; // sole centre ahead of the ankle
  footHalf: Vec3;
  fistHalf: number;
  kneeRadius: number; // knee joint above the floor when kneeling (largest limb radius at the knee)
  standHipHeight: number; // hip centre above the floor, legs straight
}

function findPart(design: RobotDesign, tags: PartTag[], fallbackId: string): PartDef {
  const byTags = design.parts.find((p) => tags.every((t) => p.tags.includes(t)));
  const p = byTags ?? design.parts.find((x) => x.id === fallbackId);
  if (!p) throw new Error(`${design.id}: no part tagged [${tags.join(', ')}] (or '${fallbackId}')`);
  return p;
}

function boxOf(p: PartDef): { half: Vec3; pos: Vec3 } | null {
  const g = p.geoms.find((x: GeomDef) => x.shape.type === 'box');
  if (!g || g.shape.type !== 'box') return null;
  return { half: g.shape.halfSize, pos: g.pos ?? [0, 0, 0] };
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

export function robotModel(design: RobotDesign): RobotModel {
  const bodies: ModelBody[] = [];
  const joints: ModelJoint[] = [];
  const bodyIndex = new Map<string, number>();
  for (const part of design.parts) {
    const index = bodies.length;
    const parent = part.parent ? bodyIndex.get(part.parent) ?? -1 : -1;
    if (part.parent && parent < 0) throw new Error(`${design.id}: part '${part.id}' parent '${part.parent}' must come first`);
    const body: ModelBody = {
      id: part.id, index, parent, pos: [...part.pos] as Vec3,
      rot: part.quat ? matFromQuat(part.quat) : identity(), joints: [], part,
    };
    (part.joints ?? []).forEach((j, slot) => {
      if (j.type !== 'hinge') return; // slides are not part of a humanoid limb chain
      const ji = joints.length;
      const lo = (j.rangeDeg[0] * Math.PI) / 180, hi = (j.rangeDeg[1] * Math.PI) / 180;
      joints.push({ name: j.name, index: ji, body: index, slot, axis: normalize(j.axis), lo, hi, solveLo: lo, solveHi: hi });
      body.joints.push(ji);
    });
    if (body.joints.length === 3) {
      const [a, b, c] = body.joints.map((x) => joints[x].axis);
      const ortho = (u: Vec3, v: Vec3) => Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) < 1e-6;
      if (ortho(a, b) && ortho(b, c) && ortho(a, c)) {
        const mid = joints[body.joints[1]];
        const lock = Math.PI / 2 - GIMBAL_MARGIN_RAD;
        mid.solveLo = Math.max(mid.lo, -lock);
        mid.solveHi = Math.min(mid.hi, lock);
      }
    }
    bodies.push(body);
    bodyIndex.set(part.id, index);
  }
  const jointIndex = new Map(joints.map((j) => [j.name, j.index]));
  const B = (tags: PartTag[], id: string) => bodyIndex.get(findPart(design, tags, id).id)!;
  const pelvis = B(['pelvis'], 'pelvis');
  const torso = B(['torso'], 'torso');
  const head = B(['head'], 'head');

  const chainJoints = (from: number, to: number): number[] => {
    const path: number[] = [];
    for (let b = to; b !== from && b >= 0; b = bodies[b].parent) path.unshift(b);
    return path.flatMap((b) => bodies[b].joints);
  };
  const limb = (kind: LimbKind, side: Side): Limb => {
    const t: PartTag = side === 'l' ? 'left' : 'right';
    const names = kind === 'arm' ? (['upperarm', 'forearm', 'fist'] as const) : (['thigh', 'shin', 'foot'] as const);
    const ids = names.map((n) => B([n, t], `${n}_${side}`));
    const base = bodies[ids[0]].parent;
    return {
      kind, side, base, bodies: ids, joints: chainJoints(base, ids[2]),
      upper: len(bodies[ids[1]].pos),
      lower: len(bodies[ids[2]].pos),
    };
  };
  const arms = { l: limb('arm', 'l'), r: limb('arm', 'r') };
  const legs = { l: limb('leg', 'l'), r: limb('leg', 'r') };

  const hipL = bodies[legs.l.bodies[0]].pos, hipR = bodies[legs.r.bodies[0]].pos;
  const shL = bodies[arms.l.bodies[0]].pos, shR = bodies[arms.r.bodies[0]].pos;
  const torsoBox = boxOf(bodies[torso].part);
  const footBox = boxOf(bodies[legs.l.bodies[2]].part);
  const fistBox = boxOf(bodies[arms.l.bodies[2]].part);
  const legLength = legs.l.upper + legs.l.lower;
  const soleDepth = footBox ? -footBox.pos[2] + footBox.half[2] : 0.08;
  const hipCenter: Vec3 = [(hipL[0] + hipR[0]) / 2, (hipL[1] + hipR[1]) / 2, (hipL[2] + hipR[2]) / 2];
  const shoulderCenter: Vec3 = [(shL[0] + shR[0]) / 2, (shL[1] + shR[1]) / 2, (shL[2] + shR[2]) / 2];
  const dims: RobotDims = {
    legLength,
    armLength: arms.l.upper + arms.l.lower,
    hipCenter,
    hipHalfWidth: Math.abs(hipL[1] - hipR[1]) / 2,
    shoulderCenter,
    shoulderHalfWidth: Math.abs(shL[1] - shR[1]) / 2,
    chestFront: torsoBox ? torsoBox.pos[0] + torsoBox.half[0] - shoulderCenter[0] : 0.12,
    soleDepth,
    footCenterX: footBox ? footBox.pos[0] : 0,
    footHalf: footBox ? footBox.half : [0.12, 0.06, 0.03],
    fistHalf: fistBox ? fistBox.half[0] : 0.06,
    kneeRadius: Math.max(0.03, ...[legs.l.bodies[0], legs.l.bodies[1]].flatMap((b) => bodies[b].part.geoms)
      .map((g) => (g.shape.type === 'capsule' || g.shape.type === 'cylinder' ? g.shape.radius : 0))),
    standHipHeight: legLength + soleDepth,
  };
  return { design, bodies, joints, jointIndex, bodyIndex, pelvis, torso, head, waistJoints: chainJoints(pelvis, torso), neckJoints: chainJoints(torso, head), arms, legs, dims };
}

// ---------------------------------------------------------------- forward kinematics

export interface BodyFrames {
  pos: Vec3[];
  rot: Mat3[];
  /** World axis of every joint (valid after fk). */
  axis: Vec3[];
}

export function newFrames(m: RobotModel): BodyFrames {
  return {
    pos: m.bodies.map(() => [0, 0, 0] as Vec3),
    rot: m.bodies.map(() => identity()),
    axis: m.joints.map(() => [0, 0, 1] as Vec3),
  };
}

/** Pose one body from its parent's (already posed) frame. */
export function fkBody(m: RobotModel, b: number, q: ArrayLike<number>, f: BodyFrames): void {
  const body = m.bodies[b];
  const pp = f.pos[body.parent], pr = f.rot[body.parent];
  const o = mulMV(pr, body.pos);
  f.pos[b] = [pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]];
  let R = mulMM(pr, body.rot);
  for (const ji of body.joints) {
    const j = m.joints[ji];
    f.axis[ji] = mulMV(R, j.axis);
    R = mulMM(R, axisAngle(j.axis, q[ji]));
  }
  f.rot[b] = R;
}

/** Full-body FK: root pose plus joint angles (indexed like m.joints). */
export function fk(m: RobotModel, rootPos: Vec3, rootRot: Mat3, q: ArrayLike<number>, f: BodyFrames = newFrames(m)): BodyFrames {
  for (let b = 0; b < m.bodies.length; b++) {
    if (m.bodies[b].parent < 0) {
      f.pos[b] = [...rootPos] as Vec3;
      f.rot[b] = [...rootRot] as Mat3;
      continue;
    }
    fkBody(m, b, q, f);
  }
  return f;
}

/** World point from a body-local point. */
export function bodyPoint(f: BodyFrames, b: number, local: Vec3): Vec3 {
  const o = mulMV(f.rot[b], local);
  return [f.pos[b][0] + o[0], f.pos[b][1] + o[1], f.pos[b][2] + o[2]];
}

/** Local points on a part's collision geoms that bound it (box corners, capsule caps). */
export function geomExtremes(g: GeomDef): Array<{ p: Vec3; r: number }> {
  const s = g.shape;
  if (s.type === 'box') {
    const c = g.pos ?? [0, 0, 0];
    const R = g.quat ? matFromQuat(g.quat) : identity();
    const out: Array<{ p: Vec3; r: number }> = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const d = mulMV(R, [sx * s.halfSize[0], sy * s.halfSize[1], sz * s.halfSize[2]]);
      out.push({ p: [c[0] + d[0], c[1] + d[1], c[2] + d[2]], r: 0 });
    }
    return out;
  }
  if (s.type === 'sphere') return [{ p: g.pos ?? [0, 0, 0], r: s.radius }];
  return [{ p: s.from, r: s.radius }, { p: s.to, r: s.radius }];
}

/** Lowest world z of a body's collision geoms. */
export function bodyLowestZ(m: RobotModel, f: BodyFrames, b: number): number {
  let z = Infinity;
  for (const g of m.bodies[b].part.geoms) {
    for (const e of geomExtremes(g)) z = Math.min(z, bodyPoint(f, b, e.p)[2] - e.r);
  }
  return z;
}
