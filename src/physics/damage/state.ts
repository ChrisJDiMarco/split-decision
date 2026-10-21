// Damage-model state: per-geom lookup tables, per-part and per-joint wear, contact episodes and
// strike groups, physical dents, and the ledger the tools read.
// Built once per SimContext (a reset builds a new context, so state never leaks across fights).
import { ARENA } from '../../core/arena-spec';
import type { DentMode, JointCause, JointFailure, JointRole } from '../../core/protocol';
import type { Corner, GeomDef, GeomRole, HydraulicCircuit, PartDef, PartTag, Vec3 } from '../../core/types';
import { MATERIALS } from '../../robots/catalog';
import type { PartRuntime, RobotRuntime, SimContext } from '../sim-context';
import { CUSHION_MATERIALS, DAMAGE_TUNING, WORLD_SURFACES } from './constants';
import { driveRatings, durabilityProfile, type DriveRatings, type DurabilityProfile, type ZoneId } from './durability';
import { worldSurface, type Surface as ShellSurface } from './shell';

export const GEOM_KIND = { NONE: 0, ROBOT: 1, DEBRIS: 2, CANVAS: 3, FENCE: 4, POST: 5, PROP: 6 } as const;
export type GeomKind = (typeof GEOM_KIND)[keyof typeof GEOM_KIND];

/** Hardness and sparks of a surface (presentation: the impact event's `metal` flag). */
export interface Surface {
  brinell: number;
  yieldMPa: number;
  sparks: boolean;
  /** An elastomer pad (a rubber sole) or a glove: it soaks up the blow instead of yielding like a metal. */
  cushion?: boolean;
}

/** Who loaded a part's joints in the current arm window, for the joint events' cause. */
export interface ArmContext {
  role: JointRole;
  byCorner: Corner | null; // the robot whose strike it was (null: a prop)
  byPart: string | null; // its striking part
  skill: string | null; // what that robot's body was doing (r.skill), e.g. 'hook'
}

export interface PartInfo {
  robot: RobotRuntime;
  part: PartRuntime;
  def: PartDef;
  /** Indices into robot.joints of the joints that live in this part (between it and its parent). */
  jointIdx: number[];
  /** Joints of the parts hanging off this one: their drives sit at this part's far end (housing hits). */
  childJointIdx: number[];
  /** Parts that leave with this one when it detaches (its rigid descendants). */
  carried: PartInfo[];
  circuits: HydraulicCircuit[];
  /** Set on the first hard hit on a hydraulic part; the leak grows with damage from then on. */
  punctured: boolean;
  /** This part and its ancestors up to the root: the joints an impact on this part loads. */
  loadPath: PartInfo[];
  /** Joint-load channels are armed for this part's joints until this tick (set by strikes). */
  armedUntil: number;
  arm: ArmContext | null;
  /** Cracks per zone: a cracked panel keeps DAMAGE_TUNING.crackWeakening of its strength per crack. */
  weakening: Partial<Record<ZoneId, number>>;
  /** Last tick one of its geoms touched the canvas (feet: a leg standing on it carries trunk blows). */
  groundTick: number;
}

export interface GeomInfo {
  kind: GeomKind;
  body: number;
  corner: Corner | null; // owner of a robot or debris geom
  part: PartInfo | null; // robot or debris geom: the part it belongs to
  surface: Surface;
  role: GeomRole | null;
  /** The geom's definition (robot and debris geoms), for its zone and material. */
  def: GeomDef | null;
  /** World surfaces and props: their fixed shell mechanics. Robot geoms resolve theirs per contact. */
  mech: ShellSurface | null;
}

/** Mechanical state of one joint's drive: load episode peaks and the damage it carries. */
export interface JointMech {
  drive: DriveRatings;
  mjJoint: number;
  bodyId: number;
  /** Bodies with one hinge can show a permanent bend (body_quat); multi-axis bodies only bind. */
  singleHinge: boolean;
  /**
   * A strike landing this close to the joint's anchor hits the drive housing: the module's radius plus
   * the limb's (the module sits across the limb at the joint, the contact lands on the limb's surface).
   */
  housingReachM: number;
  /**
   * Permissible side moment of this joint: the module's output bearing, what the subtree it carries
   * demands (DAMAGE_TUNING.structuralG), or, under a part that can be knocked off, what its mount
   * holds (DAMAGE_TUNING.mountBendShare), whichever is largest.
   */
  bearingMomentNm: number;
  // ---- the current load episode (armed ticks)
  inEpisode: boolean;
  role: JointRole;
  arm: ArmContext | null;
  ring: Float64Array; // FILTER_TAPS samples × 3 channels (gear, stop, bearing ratios)
  ringN: number;
  peak: [number, number, number]; // filtered peaks: gear, stop, bearing (× rating)
  stopSide: number; // +1 upper limit, −1 lower, at the stop peak
  bendAxisW: Vec3 | null; // world direction of the off-axis moment at the bearing peak
  // ---- damage carried
  slipCapNm: number | null; // a QDD that shed a tooth slips above this torque
  teeth: number; // teeth shed
  faultUntil: number; // tick: the drive is faulted (no torque) until then
  faults: number;
  encoderSlop: number; // extra backlash wander from housing hits, rad
  bendRad: number; // permanent bend target
  bendApplied: number; // what body_quat shows now (ramps toward bendRad)
  bendAxisP: Vec3 | null; // bend axis in the parent body frame
  baseQuat: [number, number, number, number]; // the body's design quaternion
  hyperRad: number; // how far its stop gave way
  /** Health lost through the bearing channel (wear and bends): under a detachable part, its mount's wear. */
  bearingLoss: number;
}

export interface Limb {
  parts: PartInfo[];
  jointIdx: number[];
}

/** One permanent mark on a shell, published in telemetry so the renderer dents at the contact point. */
export interface DentRecord {
  seq: number;
  part: string;
  pos: Vec3; // part frame
  normal: Vec3; // part frame, pointing out of the shell
  depthM: number;
  radiusM: number;
  mode: DentMode;
  cracked: boolean;
  whiten: number;
  time: number;
}

/** Joint health lost, by channel (cause) and by the robot's role in the hit. */
export type LossByRole = Record<JointRole, number>;

/** What the damage model did to one robot this fight (tools/fight-metrics.ts, tools/strike-bench.ts). */
/** One joint injury, as booked (the most recent LEDGER_LOG of them). */
export interface InjuryRecord {
  t: number;
  joint: string;
  cause: JointCause;
  failure: JointFailure;
  severity: number;
  role: JointRole;
  loss: number;
  by: string | null; // the striking part and what that body was doing, e.g. 'fist_r (hook)'
}

/** Injury records kept per robot. */
export const LEDGER_LOG = 64;

/** One part knocked off, and the blow that did it (src/physics/damage/detach.ts). */
export interface DetachRecord {
  t: number;
  part: string;
  /** Only these can pop a part: a clean strike by the other robot, or a thrown prop. */
  cause: 'strike' | 'prop';
  byCorner: Corner | null;
  by: string | null; // the striking part and what that body was doing, e.g. 'fist_l (jab)'
  impactNs: number; // the blow's impact impulse (first DAMAGE_TUNING.impactWindowS)
  windowNs: number; // everything the part took in the strike window
  speed: number; // closing speed at first touch, m/s
  thresholdNs: number; // what it needed: rating × mountScale × mount
  mount: number; // the mount's wear factor at the time (1 = intact)
}

export interface DamageLedger {
  jointLoss: Record<JointCause, LossByRole>;
  failures: Record<JointFailure, number>;
  /** The most recent injuries (wear included), oldest first. */
  log: InjuryRecord[];
  /** Joints that became degraded or worse (each joint counts once). */
  injured: string[];
  /** Ticks of the load episodes per channel that passed their onset / break (calibration). */
  overloads: Record<'gear' | 'stop' | 'bearing', { onset: number; broke: number; peak: number }>;
  dents: { count: number; cracks: number; byZone: Partial<Record<ZoneId, number>>; maxDepthM: number; plasticJ: number };
  partPoints: number;
  /** Parts knocked off this fight, with the blow that did it. */
  detaches: DetachRecord[];
}

export interface RobotDamage {
  robot: RobotRuntime;
  profile: DurabilityProfile;
  parts: Map<string, PartInfo>;
  mech: JointMech[];
  limbs: Limb[];
  downS: number;
  dents: DentRecord[]; // the most recent, for telemetry
  dentSeq: number;
  ledger: DamageLedger;
}

/**
 * One contact pair (two geoms) from first touch to separation. Robot-robot pairs belong to a strike
 * or push group; the rest are their own group.
 */
export interface Episode {
  a: number; // geom ids, a < b
  b: number;
  startTick: number;
  lastTick: number;
  active: boolean; // false = resting or already measured: ignore until separation
  group: HitGroup | null;
  impulse: number; // ∫ normal force dt, N·s
  jx: number; // impulse vector acting on geom b, N·s (negate for geom a)
  jy: number;
  jz: number;
  work: number; // ∫ F·v_closing dt: the work the contact absorbed, J
  /** This tick's Σ F and Σ F·v over the pair's contacts, and the last settled tick's (trapezoid rule). */
  tickF: number;
  tickFV: number;
  prevF: number;
  prevV: number;
  peakForce: number;
  pos: [number, number, number];
  speed: number; // closing speed at first touch
  massEff: number; // reduced mass of the two bodies (presentation energy)
  striker: 'a' | 'b'; // the side that was moving into the other
  /** Share of the absorbed work that goes into geom a's surface (the rest into b's). */
  shareA: number;
  tallyA: Tally | null;
  tallyB: Tally | null;
}

/** What one part took in a group: impulse, work into its surface, peak local force and where. */
export interface Tally {
  info: PartInfo;
  geom: GeomInfo;
  other: GeomInfo; // the surface that hit it (at its peak)
  zone: ZoneId;
  surface: ShellSurface;
  impulse: number;
  jx: number; // impulse on this part, world
  jy: number;
  jz: number;
  work: number; // its share of the absorbed work
  peakForce: number; // the largest single-contact force, as the solver gave it
  /** Largest single-contact force this step, and the last few steps of it (DAMAGE_TUNING.forceFilterSteps). */
  tickForce: number;
  forceRing: number[];
  /** Peak of the filtered force: what the shell's yield and a drive housing feel. */
  filtPeak: number;
  pos: Vec3; // world, at peak force
  normal: Vec3; // world, pushing into this part
  localPos: Vec3; // the same point in the part's body frame, taken at the peak (where the dent goes)
  localNormal: Vec3; // out of the shell, part frame
  striking: boolean; // it is on the striking side of its pair
  /** Fastest first-touch closing speed among the pairs that landed on this part (clean-hit test). */
  speed: number;
  /** Tick of its first contact force (−1 before), and the surface that made it. */
  t0: number;
  firstOther: GeomInfo | null;
  /** Impulse in the first DAMAGE_TUNING.impactWindowS from t0: the blow, not the lean after it. */
  jImpact: number;
}

/**
 * A group of contact pairs measured as one: a strike (robot on robot, the first strikeWindowS from
 * first touch), a push (contact soon after a strike), or a single pair (canvas, cage, debris, props).
 */
export interface HitGroup {
  kind: 'strike' | 'push' | 'pair';
  striker: Corner | null;
  victim: Corner | null;
  startTick: number;
  closeTick: number; // measuring ends after this tick
  first: Episode;
  pairs: Episode[];
  tallies: Tally[];
  impulse: number;
  work: number;
  peakForce: number;
  speed: number;
  done: boolean;
}

export interface DamageState {
  ngeom: number;
  geoms: Array<GeomInfo | null>;
  robots: [RobotDamage, RobotDamage];
  episodes: Map<number, Episode>;
  /** Open strike / push group per striking corner. */
  strikes: [HitGroup | null, HitGroup | null];
  pushes: [HitGroup | null, HitGroup | null];
  /** Tick the last strike group of each striking corner closed (push tail). */
  strikeEnd: [number, number];
  pairGroups: Set<HitGroup>;
  /** model joint id → [corner, joint index] (robot joints only). */
  jointOf: Map<number, [Corner, number]>;
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

/** Samples in the load filter (DAMAGE_TUNING.loadFilterS at a 1 ms step). */
export const FILTER_TAPS = 3;

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

const lossByRole = (): LossByRole => ({ victim: 0, striker: 0, none: 0 });

export function emptyLedger(): DamageLedger {
  return {
    jointLoss: { gear: lossByRole(), bearing: lossByRole(), hyperextension: lossByRole(), housing: lossByRole(), thermal: lossByRole(), detach: lossByRole() },
    failures: { wear: 0, seize: 0, strip: 0, slip: 0, bend: 0, hyperextension: 0, fault: 0, seal: 0, detach: 0 },
    log: [],
    injured: [],
    overloads: { gear: { onset: 0, broke: 0, peak: 0 }, stop: { onset: 0, broke: 0, peak: 0 }, bearing: { onset: 0, broke: 0, peak: 0 } },
    dents: { count: 0, cracks: 0, byZone: {}, maxDepthM: 0, plasticJ: 0 },
    partPoints: 0,
    detaches: [],
  };
}

function profileFor(ctx: SimContext, robot: RobotRuntime): DurabilityProfile {
  const model = ctx.model;
  const massKg = model.body_subtreemass[robot.rootBody] as number;
  const head = robot.parts.get('head');
  const headKg = head ? (model.body_mass[head.body] as number) : 0;
  return durabilityProfile(robot.design, { massKg, headKg, comHeightM: robot.design.rootHeight });
}

/**
 * Radius of a limb: its largest capsule or cylinder. A drive in a limb sits across the limb, so a hit
 * on the limb's surface at the joint is a hit on its housing. Box parts (torso, pelvis, head, feet)
 * enclose their drives: 0, so only a hit right at the joint reaches the housing.
 */
function limbRadius(def: PartDef | undefined): number {
  let r = 0;
  for (const g of def?.geoms ?? []) {
    const s = g.shape;
    if (s.type === 'capsule' || s.type === 'cylinder' || s.type === 'sphere') r = Math.max(r, s.radius);
  }
  return r;
}

/** How far a part reaches from a joint's anchor: the farthest point of its geoms (centre + bounding radius). */
function partReach(ctx: SimContext, robot: RobotRuntime, partId: string, mjJoint: number): number {
  const gx = ctx.data.geom_xpos as Float64Array;
  const rb = ctx.model.geom_rbound as Float64Array;
  const xa = ctx.data.xanchor as Float64Array;
  let reach = 0;
  for (const g of robot.parts.get(partId)?.geoms ?? []) {
    const d = Math.hypot(gx[g * 3] - xa[mjJoint * 3], gx[g * 3 + 1] - xa[mjJoint * 3 + 1], gx[g * 3 + 2] - xa[mjJoint * 3 + 2]);
    reach = Math.max(reach, d + rb[g]);
  }
  return reach;
}

function jointMech(ctx: SimContext, robot: RobotRuntime, i: number): JointMech {
  const { model } = ctx;
  const j = robot.joints[i];
  const mjJoint = model.dof_jntid[j.dadr] as number;
  const bodyId = model.jnt_bodyid[mjJoint] as number;
  const bq = model.body_quat as Float64Array;
  const drive = driveRatings(j.motor);
  const part = robot.design.parts.find((p) => p.id === j.part);
  const parent = robot.design.parts.find((p) => p.id === part?.parent);
  // Structural floor: the subtree this joint carries, at its centre of mass (stance pose at build).
  const subMass = model.body_subtreemass[bodyId] as number;
  const sc = ctx.data.subtree_com as Float64Array;
  const xa = ctx.data.xanchor as Float64Array;
  const lever = Math.hypot(sc[bodyId * 3] - xa[mjJoint * 3], sc[bodyId * 3 + 1] - xa[mjJoint * 3 + 1], sc[bodyId * 3 + 2] - xa[mjJoint * 3 + 2]);
  const t = DAMAGE_TUNING;
  const structural = t.structuralG * subMass * 9.81 * lever;
  // The joint under a part that can be knocked off (the neck under the head) is that part's mount, rated
  // for its pop load landing anywhere on the part (the lever is the part's reach from the joint: a jab on
  // the crown of a short robot's head levers the neck twice as hard as one at its centre of mass). It
  // yields (bends) at mountBendShare of that, not at the neck module's own bearing rating, which folded
  // under routine jabs.
  const spec = part?.detachable;
  const mount = spec ? (t.mountBendShare * ((spec.impulseNs * t.mountScale) / t.mountPulseS) * partReach(ctx, robot, j.part, mjJoint)) / (t.bearingBreak * t.bearingStaticFactor) : 0;
  return {
    drive,
    mjJoint,
    bodyId,
    singleHinge: (model.body_jntnum[bodyId] as number) === 1,
    housingReachM: drive.housingRadiusM + Math.max(limbRadius(part), limbRadius(parent)) + t.housingMarginM,
    bearingMomentNm: Math.max(drive.bearingMomentNm, structural, mount),
    inEpisode: false,
    role: 'none',
    arm: null,
    ring: new Float64Array(FILTER_TAPS * 3),
    ringN: 0,
    peak: [0, 0, 0],
    stopSide: 0,
    bendAxisW: null,
    slipCapNm: null,
    teeth: 0,
    faultUntil: -1,
    faults: 0,
    encoderSlop: 0,
    bendRad: 0,
    bendApplied: 0,
    bendAxisP: null,
    baseQuat: [bq[bodyId * 4], bq[bodyId * 4 + 1], bq[bodyId * 4 + 2], bq[bodyId * 4 + 3]],
    hyperRad: 0,
    bearingLoss: 0,
  };
}

function buildRobotDamage(ctx: SimContext, robot: RobotRuntime, geoms: Array<GeomInfo | null>): RobotDamage {
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
      childJointIdx: [],
      carried: [],
      circuits: (design.hydraulics ?? []).filter((h) => h.parts.includes(def.id)),
      punctured: false,
      loadPath: [],
      armedUntil: -1,
      arm: null,
      weakening: {},
      groundTick: -1,
    });
  }
  for (const info of parts.values()) {
    for (const c of children.get(info.def.id) ?? []) info.childJointIdx.push(...(parts.get(c.id)?.jointIdx ?? []));
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
      geoms[gid] = { kind: GEOM_KIND.ROBOT, body: info.part.body, corner: robot.corner, part: owner, surface: surfaceOf(g), role: g.role, def: g, mech: null };
    });
    if (info.part.debrisBody !== null) {
      const merged = mergedGeoms(def, children);
      info.part.debrisGeoms.forEach((gid, i) => {
        const g = merged[i] ?? def.geoms[0];
        geoms[gid] = { kind: GEOM_KIND.DEBRIS, body: info.part.debrisBody!, corner: robot.corner, part: info, surface: surfaceOf(g), role: g.role, def: g, mech: null };
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
    profile: profileFor(ctx, robot),
    parts,
    mech: robot.joints.map((_, i) => jointMech(ctx, robot, i)),
    limbs: [...limbMap.values()],
    downS: 0,
    dents: [],
    dentSeq: 0,
    ledger: emptyLedger(),
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
  const mark = (id: number, kind: GeomKind, surface: Surface, mech: ShellSurface) => {
    if (id >= 0) geoms[id] = { kind, body: 0, corner: null, part: null, surface, role: null, def: null, mech };
  };
  mark(worldGeom(ctx, 'canvas'), GEOM_KIND.CANVAS, WORLD_SURFACES.canvas, worldSurface('canvas'));
  for (let i = 0; i < ARENA.SIDES; i++) {
    mark(worldGeom(ctx, `fence_${i}`), GEOM_KIND.FENCE, WORLD_SURFACES.fence, worldSurface('fence'));
    mark(worldGeom(ctx, `post_${i}`), GEOM_KIND.POST, WORLD_SURFACES.post, worldSurface('post'));
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
      ? { kind: GEOM_KIND.CANVAS, body: 0, corner: null, part: null, surface: WORLD_SURFACES.canvas, role: null, def: null, mech: worldSurface('canvas') }
      : {
        kind: GEOM_KIND.PROP, body, corner: null, part: null, surface: { brinell: steel.brinell, yieldMPa: steel.yieldMPa, sparks: true }, role: null, def: null,
        mech: { material: 'steel', mode: 'dent', thicknessM: 0, radiusM: 0, stiffness: 2e8, collapseN: Infinity, elasticJ: Infinity, sparks: true },
      };
  }
}

export function buildDamageState(ctx: SimContext): DamageState {
  const ngeom = ctx.model.ngeom as number;
  const geoms: Array<GeomInfo | null> = new Array(ngeom).fill(null);
  const robots: [RobotDamage, RobotDamage] = [
    buildRobotDamage(ctx, ctx.robots[0], geoms),
    buildRobotDamage(ctx, ctx.robots[1], geoms),
  ];
  classifyWorld(ctx, geoms);
  const jointOf = new Map<number, [Corner, number]>();
  for (const rd of robots) rd.mech.forEach((m, i) => jointOf.set(m.mjJoint, [rd.robot.corner, i]));
  return {
    ngeom, geoms, robots,
    episodes: new Map(),
    strikes: [null, null],
    pushes: [null, null],
    strikeEnd: [-1e9, -1e9],
    pairGroups: new Set(),
    jointOf,
    velBuf: velBufFor(ctx.mj),
  };
}
