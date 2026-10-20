// NEXT GEN Phase 0 variant builder (docs/design/next-gen-chassis.md §6). In memory only: every
// variant is a deep copy of SAVATE as committed (tools/nextgen/savate-base.ts) with exactly one change added to the one
// before, so each difference is attributable. Nothing is registered and no production file changes.
//   A   stock SAVATE
//   R   A + the NEXT GEN ranges (§3)
//   M   R + drive mass moved toward the pelvis (hip drums at the hip centre, knee drive at the knee,
//       ankle drives high on the shin), stock yaw → roll → pitch order
//   O   M + the T800-style hip: pitch about an axis tilted 15° (outer end down), then roll, then yaw
//       about the thigh bone, drums apart on link bodies but axes meeting at one hip centre (§4.1)
//   P   O + PINWHEEL drives (§2: hip pitch / knee ake90x3, roll ake90x2, yaw ake90, ankles rs04,
//       waist yaw ake90)
//   P′  P + EngineAI Q300HL-class reflected armature (0.2427 kg·m²) on hip pitch and knee
// Relocated drive mass uses massless clones of the catalog motors (same torque, speed and heat
// model) plus small dense "drum" spheres carrying each motor's catalog mass where the drum sits.
import type { GeomDef, JointDef, PartDef, RobotDesign, Vec3 } from '../../src/core/types';
import { MOTORS, motor } from '../../src/robots/catalog';
import { SAVATE_BASE } from './savate-base';
import { DEG } from './math3';
import { pitchAxis, solveHip, fkHip, rotCost, sideRange, type HipRanges, type Layout, type Side } from './hipik';

export type VariantId = 'A' | 'R' | 'M' | 'O' | 'P' | 'P2' | 'PA';
/** The six §6 variants, then PA: a tuning probe added after the first holds (P with AKE90 ankles). */
export const VARIANTS: readonly VariantId[] = ['A', 'R', 'M', 'O', 'P', 'P2', 'PA'];
export const LABEL: Record<VariantId, string> = { A: 'A', R: 'R', M: 'M', O: 'O', P: 'P', P2: 'P′', PA: 'P+ak' };

/** Leg and waist ranges in degrees, LEFT side (roll, yaw and ankle roll mirror on the right). */
export interface LegRanges {
  hipPitch: [number, number]; hipRoll: [number, number]; hipYaw: [number, number];
  knee: [number, number]; anklePitch: [number, number]; ankleRoll: [number, number]; waistYaw: [number, number];
}
/** The modern builder's ranges (src/robots/humanoid.ts MODERN_RANGES), copied for reference. */
export const MODERN_LEG: LegRanges = { hipPitch: [-145, 35], hipRoll: [-35, 70], hipYaw: [-45, 70], knee: [0, 150], anklePitch: [-60, 60], ankleRoll: [-40, 40], waistYaw: [-90, 90] };
/** next-gen-chassis.md §3, the NEXT GEN proposal. */
export const NEXT_LEG: LegRanges = { hipPitch: [-150, 60], hipRoll: [-30, 110], hipYaw: [-80, 180], knee: [0, 140], anklePitch: [-39, 39], ankleRoll: [-20, 17], waistYaw: [-160, 160] };

/** EngineAI Q300HL reflected armature (docs/research/10 §3.4). */
export const Q300HL_ARMATURE = 0.2427;

/** PINWHEEL's drives (§2). Arms and neck stay SAVATE's. */
export const PINWHEEL_DRIVES = { hipPitch: 'qdd.ake90x3', hipRoll: 'qdd.ake90x2', hipYaw: 'qdd.ake90', knee: 'qdd.ake90x3', ankle: 'qdd.rs04', waistYaw: 'qdd.ake90' } as const;

export interface Variant {
  id: VariantId;
  label: string;
  design: RobotDesign;
  layout: Layout;
  ranges: LegRanges;
  /** The hip drives' catalog ids by joint (left and right alike). */
  drives: { hipPitch: string; hipRoll: string; hipYaw: string; knee: string; ankle: string; waistYaw: string };
  massRelocated: boolean;
  notes: string[];
}

// ---------------------------------------------------------------- builder rules (copied, not imported)
// The production builder's servo rules (src/robots/humanoid.ts hinge()), copied so a variant's new
// drives get gains exactly as the builder would give them.
const SERVO_FULL_TORQUE_ERROR_RAD = 0.07;
const ANKLE_FULL_TORQUE_ERROR_RAD = 0.1;
function servo(motorId: string, ankle: boolean): Pick<JointDef, 'kp' | 'kd' | 'armature' | 'damping' | 'frictionloss'> {
  const spec = motor(motorId);
  const kp = spec.stallTorqueNm / (ankle ? ANKLE_FULL_TORQUE_ERROR_RAD : SERVO_FULL_TORQUE_ERROR_RAD);
  return { kp, kd: kp * 0.045, armature: 0.02 + spec.massKg * 0.01, damping: 0.5, frictionloss: spec.stallTorqueNm * 0.004 };
}

/** A massless clone of a catalog motor: same torque, speed, heat and ratings, mass carried by a drum geom. */
function massless(id: string): string {
  const nid = `ng0.${id}`;
  if (!MOTORS[nid]) MOTORS[nid] = { ...motor(id), id: nid, name: `${motor(id).name} (mass on a drum geom)`, massKg: 0 };
  return nid;
}
const realId = (id: string) => (id.startsWith('ng0.') ? id.slice(4) : id);

// ---------------------------------------------------------------- helpers

const clone = <T>(x: T): T => structuredClone(x);
const part = (d: RobotDesign, id: string): PartDef => {
  const p = d.parts.find((x) => x.id === id);
  if (!p) throw new Error(`no part ${id}`);
  return p;
};
const joint = (d: RobotDesign, name: string): JointDef => {
  for (const p of d.parts) for (const j of p.joints ?? []) if (j.name === name) return j;
  throw new Error(`no joint ${name}`);
};
const SIDES: readonly Side[] = ['l', 'r'];

function setRange(d: RobotDesign, name: string, side: Side, leftDeg: [number, number], mirror: boolean) {
  const r = sideRange(side, leftDeg, mirror);
  joint(d, name).rangeDeg = [Number((r[0] / DEG).toFixed(9)), Number((r[1] / DEG).toFixed(9))];
}

function applyRanges(d: RobotDesign, R: LegRanges) {
  for (const s of SIDES) {
    setRange(d, `hip_pitch_${s}`, s, R.hipPitch, false);
    setRange(d, `hip_roll_${s}`, s, R.hipRoll, true);
    setRange(d, `hip_yaw_${s}`, s, R.hipYaw, true);
    setRange(d, `knee_${s}`, s, R.knee, false);
    setRange(d, `ankle_pitch_${s}`, s, R.anklePitch, false);
    setRange(d, `ankle_roll_${s}`, s, R.ankleRoll, true);
  }
  joint(d, 'waist_yaw').rangeDeg = [...R.waistYaw];
}

/** SAVATE's leg geometry, read off the built design (no builder copy needed). */
export function legGeometry(d: RobotDesign) {
  const thigh = part(d, 'thigh_l');
  const shin = part(d, 'shin_l');
  const foot = part(d, 'foot_l');
  const pelvisBox = part(d, 'pelvis').geoms[0].shape;
  if (pelvisBox.type !== 'box') throw new Error('pelvis box');
  const thighCap = thigh.geoms[0].shape;
  if (thighCap.type !== 'capsule') throw new Error('thigh capsule');
  return {
    hipY: thigh.pos[1],
    hipZ: thigh.pos[2],
    thighLen: -shin.pos[2],
    shinLen: -foot.pos[2],
    pelvisHalf: pelvisBox.halfSize,
    thighR: thighCap.radius,
  };
}

/** Where the drums sit (§4.1 geometry, scaled to SAVATE; INFERRED from the T800 placement in 10 §3.5-3.6). */
function drumSites(d: RobotDesign) {
  const g = legGeometry(d);
  const k = g.thighLen / 0.44; // the builder's thigh is 0.44 × scale × legs
  return {
    // hip-pitch drum: out to the side in the pelvis, on the pitch axis line
    pelvis: (s: number): Vec3 => [0, s * (g.hipY + 0.035 * k), g.hipZ + 0.02 * k],
    // roll drum: in front of the hip centre, on the roll axis
    front: [0.055 * k, 0, 0] as Vec3,
    // yaw drum: down the thigh bone, ~8 cm (T800: 8.05 cm below roll)
    thighTop: [0, 0, -0.07 * k] as Vec3,
    // ankle drives high on the shin (T800: 0.196 and 0.278 m above a 0.439 m shin's ankle)
    ankleHi: [[0, 0, -g.shinLen * (1 - 0.633)], [0, 0, -g.shinLen * (1 - 0.447)]] as Vec3[],
    r: 0.02 * k,
  };
}

const drum = (pos: Vec3, motorId: string, r: number): GeomDef => ({
  shape: { type: 'sphere', radius: r }, pos, material: 'al7075', role: 'structure', massKg: motor(realId(motorId)).massKg,
});

// ---------------------------------------------------------------- the variants

export function buildVariant(id: VariantId): Variant {
  const base = SAVATE_BASE;
  const d = clone(base);
  d.id = `ng0-${id.toLowerCase()}`;
  d.name = `SAVATE-${LABEL[id]}`;
  // PA branches off P (it does not carry P′'s armature).
  const order: VariantId[] = ['A', 'R', 'M', 'O', 'P', 'P2'];
  const at = id === 'PA' ? order.indexOf('P') : order.indexOf(id);
  const has = (v: VariantId) => (v === 'PA' ? id === 'PA' : at >= order.indexOf(v));
  const notes: string[] = [];
  const drives = { hipPitch: 'qdd.ake90x2', hipRoll: 'qdd.ake90x2', hipYaw: 'qdd.ake90x2', knee: joint(d, 'knee_l').motor, ankle: joint(d, 'ankle_pitch_l').motor, waistYaw: joint(d, 'waist_yaw').motor };
  drives.hipPitch = joint(d, 'hip_pitch_l').motor;
  drives.hipRoll = joint(d, 'hip_roll_l').motor;
  drives.hipYaw = joint(d, 'hip_yaw_l').motor;
  const ranges = has('R') ? NEXT_LEG : MODERN_LEG;

  // P: new drives first (gains from the builder's rules), so M/O relocation below weighs the right motors.
  if (has('P')) {
    Object.assign(drives, PINWHEEL_DRIVES, has('PA') ? { ankle: 'qdd.ake90' } : {});
    for (const s of SIDES) {
      for (const [jn, m, ankle] of [[`hip_pitch_${s}`, drives.hipPitch, false], [`hip_roll_${s}`, drives.hipRoll, false], [`hip_yaw_${s}`, drives.hipYaw, false], [`knee_${s}`, drives.knee, false], [`ankle_pitch_${s}`, drives.ankle, true], [`ankle_roll_${s}`, drives.ankle, true]] as const) {
        Object.assign(joint(d, jn), { motor: m }, servo(m, ankle));
      }
    }
    Object.assign(joint(d, 'waist_yaw'), { motor: drives.waistYaw }, servo(drives.waistYaw, false));
    notes.push('PINWHEEL drives; gains by the builder rules (kp = stall/0.07, ankles stall/0.1)');
    if (has('PA')) notes.push('probe: ankles on single AKE90-8 (170 N·m, 1.40 kg) instead of RobStride 04 (120 N·m, 1.42 kg)');
  }
  if (has('P2')) {
    for (const s of SIDES) { joint(d, `hip_pitch_${s}`).armature = Q300HL_ARMATURE; joint(d, `knee_${s}`).armature = Q300HL_ARMATURE; }
    notes.push(`armature ${Q300HL_ARMATURE} kg·m² on hip pitch and knee (EngineAI Q300HL)`);
  }
  if (has('R')) {
    applyRanges(d, NEXT_LEG);
    notes.push('NEXT GEN ranges (§3)');
  }

  let layout: Layout = 'stock';
  if (has('M')) {
    const site = drumSites(d);
    for (const s of SIDES) {
      const sg = s === 'l' ? 1 : -1;
      const thigh = part(d, `thigh_${s}`);
      const shin = part(d, `shin_${s}`);
      const foot = part(d, `foot_${s}`);
      const jp = joint(d, `hip_pitch_${s}`), jr = joint(d, `hip_roll_${s}`), jy = joint(d, `hip_yaw_${s}`), jk = joint(d, `knee_${s}`);
      const ja = joint(d, `ankle_pitch_${s}`), jb = joint(d, `ankle_roll_${s}`);
      const pelvis = part(d, 'pelvis');
      // Knee drive at the knee (shin top), ankle drives high on the shin.
      shin.geoms.push(drum([0, 0, 0], jk.motor, site.r), drum(site.ankleHi[0], ja.motor, site.r), drum(site.ankleHi[1], jb.motor, site.r));
      jk.motor = massless(jk.motor); ja.motor = massless(ja.motor); jb.motor = massless(jb.motor);
      void foot;
      if (!has('O')) {
        // Stock order: the first drive (yaw) sits in the pelvis; roll and pitch ride the thigh top
        // at the same two sites O uses, so M and O carry equal mass in equal places.
        pelvis.geoms.push(drum(site.pelvis(sg), jy.motor, site.r));
        thigh.geoms.push(drum(site.front, jr.motor, site.r), drum(site.thighTop, jp.motor, site.r));
        jy.motor = massless(jy.motor); jr.motor = massless(jr.motor); jp.motor = massless(jp.motor);
      } else {
        // T800 order on link bodies whose axes meet at the hip centre (§4.1).
        layout = 'tilted';
        pelvis.geoms.push(drum(site.pelvis(sg), jp.motor, site.r));
        const pitchLink: PartDef = {
          id: `hip_pitch_link_${s}`, parent: 'pelvis', pos: [...thigh.pos] as Vec3, tags: ['thigh', s === 'l' ? 'left' : 'right'], hp: 700,
          joints: [{ ...jp, motor: massless(jp.motor), axis: pitchAxis(s) }],
          geoms: [drum(site.front, jr.motor, site.r)],
          visual: { kit: 'leg.thigh' },
        };
        const rollLink: PartDef = {
          id: `hip_roll_link_${s}`, parent: pitchLink.id, pos: [0, 0, 0], tags: ['thigh', s === 'l' ? 'left' : 'right'], hp: 700,
          joints: [{ ...jr, motor: massless(jr.motor), axis: [1, 0, 0] }],
          geoms: [drum(site.thighTop, jy.motor, site.r)],
          visual: { kit: 'leg.thigh' },
        };
        thigh.parent = rollLink.id;
        thigh.pos = [0, 0, 0];
        thigh.joints = [{ ...jy, motor: massless(jy.motor), axis: [0, 0, 1] }];
        const at = d.parts.indexOf(thigh);
        d.parts.splice(at, 0, pitchLink, rollLink);
      }
    }
    notes.push(has('O') ? 'tilted pitch → roll → thigh-yaw on link bodies, drums apart, axes meeting' : 'drive mass relocated (pelvis / hip centre / knee / high shin), stock order');
  }

  // The stance keeps the same thigh orientation in the tilted layout (solved through the new hip).
  if (layout === 'tilted') {
    for (const s of SIDES) {
      const st = { p: base.stance[`hip_pitch_${s}`], r: base.stance[`hip_roll_${s}`], y: base.stance[`hip_yaw_${s}`] };
      const want = fkHip('stock', s, st);
      const sol = solveHip('tilted', s, hipRangesOf({ ranges, layout } as Variant, s), rotCost(want), 4);
      if (sol.cost > 0.2 * DEG) throw new Error(`stance hip ${s} unreachable in the tilted layout (${(sol.cost / DEG).toFixed(2)}°)`);
      d.stance[`hip_pitch_${s}`] = sol.q.p;
      d.stance[`hip_roll_${s}`] = sol.q.r;
      d.stance[`hip_yaw_${s}`] = sol.q.y;
    }
  }
  return { id, label: LABEL[id], design: d, layout, ranges, drives, massRelocated: has('M'), notes };
}

/** One side's hip ranges in radians for the IK. */
export function hipRangesOf(v: Pick<Variant, 'ranges'>, side: Side): HipRanges {
  return { p: sideRange(side, v.ranges.hipPitch, false), r: sideRange(side, v.ranges.hipRoll, true), y: sideRange(side, v.ranges.hipYaw, true) };
}

/** The real (massed) catalog id of a joint's motor. */
export const motorOf = (id: string) => motor(realId(id));
