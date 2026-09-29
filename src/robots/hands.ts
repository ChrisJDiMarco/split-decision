// Dexterous hand: a palm (it keeps the fist part's id, so reach, strikes and damage still find
// 'fist_l' / 'fist_r') plus four fingers and a thumb, each two capsule phalanges on two passive
// flexion joints. One grip drive in the palm (catalog 'grip.ak60') reels a flexor tendon routed over
// all ten joints; return springs open them. That is an underactuated tendon hand in the line of
// Dollar & Howe's SDM Hand (one actuator, eight joints): the fingers close together and each stops
// where it meets something, which is what lets a hand wrap an arm in the clinch or flatten on the
// canvas without a motor per knuckle.
//
// Fist frame (src/robots/humanoid.ts): origin at the fist centre, the forearm above (+z), the knuckle
// face at −z, the palm facing the body midline (−s·y, s = +1 left) and the fingers spread along x
// (index at +x, the thumb side). Sizes scale with the stock fist half-size h.
import type { GeomDef, JointDef, PartDef, PartTag, TendonDef, Vec3 } from '../core/types';
import { MATERIALS, motor } from './catalog';
import { geomVolume } from './compile-mjcf';

const DEG = Math.PI / 180;

export const GRIP_MOTOR = 'grip.ak60';

/** Spool ratio (joint pulley / drive spool): each joint feels 0.3 × the drive torque (2.7 N·m peak). */
export const TENDON_COEF = 0.3;

/** Solid share of a phalanx: a 7075 shell with the joint pin, tendon pulley and pad. */
const PHALANX_FILL = 0.45;
/** Solid share of the palm shell around the drive, spool and wrist bearing. */
const PALM_FILL = 0.2;
/** Return spring per joint (N·m/rad): opens a slack hand in ~0.1 s; ~0.35 N·m at a full fist. */
const SPRING_NM_PER_RAD = 0.25;
/**
 * Armature per finger joint (kg·m²). The drive's reflected inertia is only ~3e-5 per joint; this is
 * set higher for the solver: a 20 g phalanx beside a 100 kg body otherwise costs MuJoCo's Newton
 * solver ~30% more iterations per step. The fist still closes in ~0.1 s.
 */
const JOINT_ARMATURE = 0.002;
/** Full drive torque at this tendon error (rad of spool travel). */
const GRIP_FULL_TORQUE_ERROR = 0.15;

interface Digit {
  index: number; // 0 thumb, 1 index .. 4 little
  base: Vec3; // proximal joint, fist frame, left hand (y is mirrored for the right)
  axis: Vec3; // flexion axis, left hand
  lengths: [number, number]; // proximal, distal (× h)
  radius: number; // × h
  rangeDeg: [[number, number], [number, number]];
  fistDeg: [number, number]; // joint angles of a clenched fist
}

/**
 * Fingers flex toward the palm (−s·y): positive rotation about −s·x. The thumb, beside the index
 * finger off the palm's +x side, flexes the same way and hooks over the palm face; folding it toward
 * −x instead swept it through the palm (no self-collision), 39 mm deep on SAVATE at a full fist.
 */
const DIGITS: Digit[] = [
  { index: 0, base: [1.1, -0.3, 0.0], axis: [-1, 0, 0], lengths: [0.42, 0.35], radius: 0.17, rangeDeg: [[-10, 70], [0, 80]], fistDeg: [58, 62] },
  ...[0.66, 0.22, -0.22, -0.66].map((x, k): Digit => ({
    index: k + 1, base: [x, -0.35, -1.0], axis: [-1, 0, 0], lengths: [0.6, 0.45 - k * 0.03], radius: 0.16, rangeDeg: [[-10, 95], [0, 110]], fistDeg: [86, 97],
  })),
];

/** Relaxed spring rest angle (a hand hanging loose is slightly curled). */
const SPRING_REF_DEG = 8;

const mirror = (v: Vec3, s: number): Vec3 => [v[0], v[1] * s, v[2]];

export const digitPartId = (side: 'l' | 'r', index: number, seg: 'p' | 'd') => `digit_${side}${index}_${seg}`;
export const digitJoint = (side: 'l' | 'r', index: number, seg: 'p' | 'd') => `digit_${side}${index}_${seg === 'p' ? 'base' : 'mid'}`;
export const gripTendon = (side: 'l' | 'r') => `grip_${side}`;

function passiveJoint(name: string, axis: Vec3, rangeDeg: [number, number]): JointDef {
  return {
    name, type: 'hinge', axis, rangeDeg, motor: GRIP_MOTOR, kp: 0, kd: 0,
    armature: JOINT_ARMATURE, damping: 0.03, frictionloss: 0, // no dry friction: each would add a solver row per joint
    passive: { stiffness: SPRING_NM_PER_RAD, springRefDeg: SPRING_REF_DEG },
  };
}

function phalanx(len: number, r: number): GeomDef {
  const g: GeomDef = { shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -len], radius: r }, material: 'al7075', role: 'striker' };
  return { ...g, massKg: geomVolume(g) * MATERIALS.al7075.densityKgM3 * PHALANX_FILL };
}

/** Tendon length of a clenched fist (the grip command 1). */
export function fistTendonLength(): number {
  return DIGITS.reduce((sum, d) => sum + TENDON_COEF * (d.fistDeg[0] + d.fistDeg[1]) * DEG, 0);
}

function maxTendonLength(): number {
  return DIGITS.reduce((sum, d) => sum + TENDON_COEF * (d.rangeDeg[0][1] + d.rangeDeg[1][1]) * DEG, 0);
}

/** The palm that replaces a fist part (same id, parent, pos and tags), with the grip drive inside. */
export function palmPart(fist: PartDef, h: number, visualKit = 'hand.palm'): PartDef {
  // The palm fills nearly the stock fist's box (0.8h thick instead of 0.9h): it houses the grip drive,
  // and its flat faces are what the get-ups plant on. A centred palm this size kept the measured
  // get-up rate of the stock fist; a thin palm with the curled fingers as the planting surface
  // (capsules roll) roughly halved it. The fingers hang from its bottom face and fold under it and
  // up its palm face.
  const half: Vec3 = [h, 0.8 * h, h];
  const box: GeomDef = { shape: { type: 'box', halfSize: half }, material: 'al7075', role: 'striker' };
  const massKg = geomVolume(box) * MATERIALS.al7075.densityKgM3 * PALM_FILL + motor(GRIP_MOTOR).massKg;
  return {
    ...fist,
    geoms: [{ ...box, massKg }],
    visual: { kit: visualKit, params: { h } },
    smokePoint: [0, 0, 0.3 * h],
  };
}

/** The ten phalanx parts of one hand, children of the palm `palmId`. */
export function digitParts(palmId: string, side: 'l' | 'r', h: number): PartDef[] {
  const s = side === 'l' ? 1 : -1;
  const sideTag: PartTag = side === 'l' ? 'left' : 'right';
  const out: PartDef[] = [];
  for (const d of DIGITS) {
    const axis: Vec3 = d.axis[0] !== 0 ? [d.axis[0] * s, 0, 0] : d.axis;
    const [lp, ld] = [d.lengths[0] * h, d.lengths[1] * h];
    const r = d.radius * h;
    const base = mirror(d.base, s).map((v) => v * h) as Vec3;
    const common = { tags: ['finger', sideTag] as PartTag[], hp: 60 };
    out.push({
      ...common, id: digitPartId(side, d.index, 'p'), parent: palmId, pos: base,
      joints: [passiveJoint(digitJoint(side, d.index, 'p'), axis, d.rangeDeg[0])],
      geoms: [phalanx(lp, r)],
      visual: { kit: 'hand.digit', params: { seg: 'p', thumb: d.index === 0, len: lp, r } },
    });
    out.push({
      ...common, id: digitPartId(side, d.index, 'd'), parent: digitPartId(side, d.index, 'p'), pos: [0, 0, -lp],
      joints: [passiveJoint(digitJoint(side, d.index, 'd'), axis, d.rangeDeg[1])],
      geoms: [phalanx(ld, r * 0.9)],
      visual: { kit: 'hand.digit', params: { seg: 'd', thumb: d.index === 0, len: ld, r: r * 0.9 } },
    });
  }
  return out;
}

/** The grip tendon of one hand: every finger joint at the spool ratio, pulled by the palm drive. */
export function gripTendonDef(side: 'l' | 'r'): TendonDef {
  const spec = motor(GRIP_MOTOR);
  const kp = spec.stallTorqueNm / GRIP_FULL_TORQUE_ERROR;
  return {
    id: gripTendon(side),
    joints: DIGITS.flatMap((d) => (['p', 'd'] as const).map((seg) => ({ joint: digitJoint(side, d.index, seg), coef: TENDON_COEF }))),
    motor: GRIP_MOTOR,
    kp,
    kd: kp * 0.045,
    pullOnly: true,
    lengthRange: [0, maxTendonLength()],
  };
}
