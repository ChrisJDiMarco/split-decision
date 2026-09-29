// Damage-model state: per-geom lookup tables, per-part and per-joint wear, contact episodes.
// Built once per SimContext (a reset builds a new context, so state never leaks across fights).
import { ARENA } from '../../core/arena-spec';
import type { Corner, GeomDef, GeomRole, HydraulicCircuit, PartDef, PartTag } from '../../core/types';
import { MATERIALS } from '../../robots/catalog';
import type { PartRuntime, RobotRuntime, SimContext } from '../sim-context';
import { CUSHION_MATERIALS, JOINT_HP_BASE, JOINT_HP_PER_NM, WORLD_SURFACES } from './constants';

export const GEOM_KIND = { NONE: 0, ROBOT: 1, DEBRIS: 2, CANVAS: 3, FENCE: 4, POST: 5, PROP: 6 } as const;
export type GeomKind = (typeof GEOM_KIND)[keyof typeof GEOM_KIND];

export interface Surface {
  brinell: number;
  yieldMPa: number;
  sparks: boolean;
  /** An elastomer pad (a rubber sole): it soaks up the blow instead of yielding like a metal. */
  cushion?: boolean;
}

export interface PartInfo {
  robot: RobotRuntime;
  part: PartRuntime;
  def: PartDef;
  /** Indices into robot.joints of the joints that live in this part (between it and its parent). */
  jointIdx: number[];
  /** Where impact damage to the joints goes: this part's joints, or the parent's if it has none. */
  woundJointIdx: number[];
  woundShare: number;
  /** Parts that leave with this one when it detaches (its rigid descendants). */
  carried: PartInfo[];
  circuits: HydraulicCircuit[];
  /** Set on the first hard hit on a hydraulic part; the leak grows with damage from then on. */
  punctured: boolean;
  /** This part and its ancestors up to the root: the joints an impact on this part loads. */
  loadPath: PartInfo[];
  /** Overload tracking is armed for this part's joints until this tick (set by impacts). */
  armedUntil: number;
}

export interface GeomInfo {
  kind: GeomKind;
  body: number;
  corner: Corner | null; // owner of a robot or debris geom
  part: PartInfo | null; // robot or debris geom: the part it belongs to
  surface: Surface;
  role: GeomRole | null;
}

export interface JointWear {
  hp: number; // damage points to destroy it
  overloadPeakNm: number; // peak back-driving torque in the current overload episode
  inOverload: boolean;
}

export interface Limb {
  parts: PartInfo[];
  jointIdx: number[];
}

export interface RobotDamage {
  robot: RobotRuntime;
  parts: Map<string, PartInfo>;
  wear: JointWear[];
  limbs: Limb[];
  downS: number;
}

export interface Episode {
  a: number; // geom ids, a < b
  b: number;
  startTick: number;
  lastTick: number;
  active: boolean; // false = resting or already measured: ignore until separation
  impulse: number; // ∫ normal force dt, N·s
  jx: number; // impulse vector acting on geom b, N·s (negate for geom a)
  jy: number;
  jz: number;
  peakForce: number;
  pos: [number, number, number];
  speed: number; // closing speed at first touch
  massEff: number; // reduced mass of the two bodies
  striker: 'a' | 'b'; // the side that was moving into the other
}

export interface DamageState {
  ngeom: number;
  geoms: Array<GeomInfo | null>;
  robots: [RobotDamage, RobotDamage];
  episodes: Map<number, Episode>;
  /** Reusable out-parameter for mj_objectVelocity. Re-read GetView() after every call: heap growth detaches old views. */
  velBuf: VelBuf;
}

type VelBuf = { delete(): void; GetView(): Float64Array };

/** One buffer per MuJoCo module: contexts are rebuilt on every reset, the module is loaded once. */
const velBufs = new WeakMap<object, VelBuf>();

function velBufFor(mj: SimContext['mj']): VelBuf {
  let buf = velBufs.get(mj);
  if (!buf) {
    buf = new mj.DoubleBuffer(6) as VelBuf;
    velBufs.set(mj, buf);
  }
  return buf;
}

const ARM_TAGS: PartTag[] = ['upperarm', 'forearm', 'fist', 'shield', 'hammer'];
const LEG_TAGS: PartTag[] = ['thigh', 'shin', 'foot', 'leg', 'wheel'];
const SIDE_TAGS: PartTag[] = ['left', 'right', 'front', 'rear'];

function surfaceOf(g: GeomDef): Surface {
  const m = MATERIALS[g.material];
  return { brinell: m.brinell, yieldMPa: m.yieldMPa, sparks: m.sparks, cushion: CUSHION_MATERIALS.includes(g.material) };
}

/** Same traversal order as compile-mjcf's debris merge: the part's own geoms, then children depth-first. */
function mergedGeoms(def: PartDef, children: Map<string, PartDef[]>): GeomDef[] {
  const out: GeomDef[] = [...def.geoms];
  for (const c of children.get(def.id) ?? []) out.push(...mergedGeoms(c, children));
  return out;
}

function childrenMap(parts: PartDef[]): Map<string, PartDef[]> {
  const map = new Map<string, PartDef[]>();
  for (const p of parts) {
    if (!p.parent) continue;
    const list = map.get(p.parent) ?? [];
    list.push(p);
    map.set(p.parent, list);
  }
  return map;
}

function limbKey(tags: PartTag[]): string | null {
  const kind = tags.some((t) => ARM_TAGS.includes(t)) ? 'arm' : tags.some((t) => LEG_TAGS.includes(t)) ? 'leg' : null;
  if (!kind) return null;
  const side = tags.filter((t) => SIDE_TAGS.includes(t)).sort().join('_');
  return side ? `${kind}_${side}` : null;
}

/** The part that takes a geom's damage: a finger's nearest non-finger ancestor, else the part itself. */
function handOwner(info: PartInfo, parts: Map<string, PartInfo>): PartInfo {
  let p: PartInfo | undefined = info;
  while (p && p.def.tags.includes('finger') && p.def.parent) p = parts.get(p.def.parent);
  return p ?? info;
}

function buildRobotDamage(robot: RobotRuntime, geoms: Array<GeomInfo | null>): RobotDamage {
  const { design } = robot;
  const defs = new Map(design.parts.map((p) => [p.id, p]));
  const children = childrenMap(design.parts);
  const parts = new Map<string, PartInfo>();
  for (const def of design.parts) {
    const part = robot.parts.get(def.id);
    if (!part) throw new Error(`damage: robot ${robot.corner} has no runtime part '${def.id}'`);
    const jointIdx = robot.joints.flatMap((j, i) => (j.part === def.id ? [i] : []));
    parts.set(def.id, {
      robot, part, def, jointIdx,
      woundJointIdx: jointIdx,
      woundShare: 1,
      carried: [],
      circuits: (design.hydraulics ?? []).filter((h) => h.parts.includes(def.id)),
      punctured: false,
      loadPath: [],
      armedUntil: -1,
    });
  }
  for (const info of parts.values()) {
    // Joint-less parts (fists, pelvis) pass half their joint damage up to the parent's joints.
    if (!info.jointIdx.length && info.def.parent) {
      info.woundJointIdx = parts.get(info.def.parent)?.jointIdx ?? [];
      info.woundShare = 0.5;
    }
    for (let p: PartInfo | undefined = info; p; p = p.def.parent ? parts.get(p.def.parent) : undefined) info.loadPath.push(p);
    if (info.def.detachable) {
      const stack = [...(children.get(info.def.id) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        info.carried.push(parts.get(c.id)!);
        stack.push(...(children.get(c.id) ?? []));
      }
    }
    // Geom lookup: attached geoms, then the parked debris twin's merged geoms. A finger phalanx
    // counts as its palm (the fist part): hits on it damage the hand, not a part of its own.
    const def = defs.get(info.def.id)!;
    const owner = handOwner(info, parts);
    info.part.geoms.forEach((gid, i) => {
      const g = def.geoms[i];
      geoms[gid] = { kind: GEOM_KIND.ROBOT, body: info.part.body, corner: robot.corner, part: owner, surface: surfaceOf(g), role: g.role };
    });
    if (info.part.debrisBody !== null) {
      const merged = mergedGeoms(def, children);
      info.part.debrisGeoms.forEach((gid, i) => {
        const g = merged[i] ?? def.geoms[0];
        geoms[gid] = { kind: GEOM_KIND.DEBRIS, body: info.part.debrisBody!, corner: robot.corner, part: info, surface: surfaceOf(g), role: g.role };
      });
    }
  }
  const limbMap = new Map<string, Limb>();
  for (const info of parts.values()) {
    const key = limbKey(info.def.tags);
    if (!key) continue;
    const limb = limbMap.get(key) ?? { parts: [], jointIdx: [] };
    limb.parts.push(info);
    limb.jointIdx.push(...info.jointIdx);
    limbMap.set(key, limb);
  }
  return {
    robot,
    parts,
    wear: robot.joints.map((j) => ({ hp: JOINT_HP_BASE + JOINT_HP_PER_NM * j.motor.stallTorqueNm, overloadPeakNm: 0, inOverload: false })),
    limbs: [...limbMap.values()],
    downS: 0,
  };
}

function worldGeom(ctx: SimContext, name: string): number {
  try {
    return ctx.model.geom(name).id as number;
  } catch {
    return -1; // not in this world (e.g. a test world without a cage)
  }
}

function classifyWorld(ctx: SimContext, geoms: Array<GeomInfo | null>): void {
  const mark = (id: number, kind: GeomKind, surface: Surface) => {
    if (id >= 0) geoms[id] = { kind, body: 0, corner: null, part: null, surface, role: null };
  };
  mark(worldGeom(ctx, 'canvas'), GEOM_KIND.CANVAS, WORLD_SURFACES.canvas);
  for (let i = 0; i < ARENA.SIDES; i++) {
    mark(worldGeom(ctx, `fence_${i}`), GEOM_KIND.FENCE, WORLD_SURFACES.fence);
    mark(worldGeom(ctx, `post_${i}`), GEOM_KIND.POST, WORLD_SURFACES.post);
  }
  // Anything else that can collide is a loose prop (steel) or unnamed world geometry (treated as canvas).
  const { model } = ctx;
  const contype = model.geom_contype;
  const conaff = model.geom_conaffinity;
  const bodyOf = model.geom_bodyid;
  const steel = MATERIALS.steel;
  for (let g = 0; g < geoms.length; g++) {
    if (geoms[g] || (contype[g] === 0 && conaff[g] === 0)) continue;
    const body = bodyOf[g];
    geoms[g] = body === 0
      ? { kind: GEOM_KIND.CANVAS, body: 0, corner: null, part: null, surface: WORLD_SURFACES.canvas, role: null }
      : { kind: GEOM_KIND.PROP, body, corner: null, part: null, surface: { brinell: steel.brinell, yieldMPa: steel.yieldMPa, sparks: true }, role: null };
  }
}

export function buildDamageState(ctx: SimContext): DamageState {
  const ngeom = ctx.model.ngeom as number;
  const geoms: Array<GeomInfo | null> = new Array(ngeom).fill(null);
  const robots: [RobotDamage, RobotDamage] = [
    buildRobotDamage(ctx.robots[0], geoms),
    buildRobotDamage(ctx.robots[1], geoms),
  ];
  classifyWorld(ctx, geoms);
  return { ngeom, geoms, robots, episodes: new Map(), velBuf: velBufFor(ctx.mj) };
}
