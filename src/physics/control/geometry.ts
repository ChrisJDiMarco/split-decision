// Reads the kinematic layout the controller needs straight from a biped RobotDesign, so the
// same code drives every humanoid (bruiser, striker, goliath) whatever its scale and bulk.
import type { GeomDef, JointDef, PartDef, RobotDesign, Vec3 } from '../../core/types';

export type Side = 'l' | 'r';
export const SIDES: readonly Side[] = ['l', 'r'];
export const sideSign = (s: Side): number => (s === 'l' ? 1 : -1);

export interface LegGeometry {
  hip: Vec3; // hip joint centre in the pelvis frame
  thigh: number; // hip → knee
  shin: number; // knee → ankle
  soleDepth: number; // ankle → sole, along foot −z
  footCenterX: number; // sole centre ahead of the ankle, foot frame
  footHalfLength: number;
  footHalfWidth: number;
}

export interface ArmGeometry {
  shoulder: Vec3; // shoulder joint centre in the torso frame
  upper: number; // shoulder → elbow
  fore: number; // elbow → fist centre
  fistHalf: number;
}

export interface JointLimit {
  lo: number;
  hi: number;
}

export interface HumanoidGeometry {
  pelvisToTorso: Vec3; // waist joint centre in the pelvis frame
  torsoCenter: Vec3; // torso armor box centre in the torso frame
  torsoHalf: Vec3;
  neck: Vec3; // neck joint in the torso frame
  headCenter: Vec3; // head box centre in the head frame
  headHalf: Vec3;
  legs: Record<Side, LegGeometry>;
  arms: Record<Side, ArmGeometry>;
  limits: Map<string, JointLimit>; // radians
  legLength: number; // thigh + shin
  armReach: number; // shoulder → fist face, fully extended
  height: number; // standing height scale, m
}

function part(design: RobotDesign, id: string): PartDef {
  const p = design.parts.find((x) => x.id === id);
  if (!p) throw new Error(`${design.id}: controller needs part '${id}'`);
  return p;
}

function boxOf(p: PartDef): { half: Vec3; pos: Vec3 } {
  const g = p.geoms.find((x: GeomDef) => x.shape.type === 'box');
  if (!g || g.shape.type !== 'box') throw new Error(`part '${p.id}' has no box geom`);
  return { half: g.shape.halfSize, pos: g.pos ?? [0, 0, 0] };
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

function leg(design: RobotDesign, s: Side): LegGeometry {
  const thigh = part(design, `thigh_${s}`);
  const shin = part(design, `shin_${s}`);
  const foot = part(design, `foot_${s}`);
  const box = boxOf(foot);
  return {
    hip: [...thigh.pos] as Vec3,
    thigh: len(shin.pos),
    shin: len(foot.pos),
    soleDepth: -box.pos[2] + box.half[2],
    footCenterX: box.pos[0],
    footHalfLength: box.half[0],
    footHalfWidth: box.half[1],
  };
}

function arm(design: RobotDesign, s: Side): ArmGeometry {
  const upper = part(design, `upperarm_${s}`);
  const fore = part(design, `forearm_${s}`);
  const fist = part(design, `fist_${s}`);
  return {
    shoulder: [...upper.pos] as Vec3,
    upper: len(fore.pos),
    fore: len(fist.pos),
    fistHalf: boxOf(fist).half[0],
  };
}

export function isHumanoid(design: RobotDesign): boolean {
  if (design.bodyType !== 'biped') return false;
  const need = ['pelvis', 'torso', 'head', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r', 'upperarm_l', 'forearm_l', 'fist_l', 'upperarm_r', 'forearm_r', 'fist_r'];
  return need.every((id) => design.parts.some((p) => p.id === id));
}

export function humanoidGeometry(design: RobotDesign): HumanoidGeometry {
  const torso = part(design, 'torso');
  const head = part(design, 'head');
  const torsoBox = boxOf(torso);
  const headBox = boxOf(head);
  const limits = new Map<string, JointLimit>();
  for (const p of design.parts) {
    for (const j of p.joints ?? ([] as JointDef[])) {
      limits.set(j.name, { lo: (j.rangeDeg[0] * Math.PI) / 180, hi: (j.rangeDeg[1] * Math.PI) / 180 });
    }
  }
  const legs = { l: leg(design, 'l'), r: leg(design, 'r') };
  const arms = { l: arm(design, 'l'), r: arm(design, 'r') };
  const pelvisBox = boxOf(part(design, 'pelvis'));
  const legLength = legs.l.thigh + legs.l.shin;
  return {
    pelvisToTorso: [...torso.pos] as Vec3,
    torsoCenter: torsoBox.pos,
    torsoHalf: torsoBox.half,
    neck: [...head.pos] as Vec3,
    headCenter: headBox.pos,
    headHalf: headBox.half,
    legs,
    arms,
    limits,
    legLength,
    armReach: arms.l.upper + arms.l.fore + arms.l.fistHalf,
    height: legs.l.soleDepth + legLength + pelvisBox.half[2] + torso.pos[2] + head.pos[2] + headBox.half[2] * 2,
  };
}

export function limitOf(geo: HumanoidGeometry, joint: string): JointLimit {
  return geo.limits.get(joint) ?? { lo: -Math.PI, hi: Math.PI };
}
