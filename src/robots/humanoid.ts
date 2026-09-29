// Parametric humanoid fighter. Local frame: x forward, y left, z up.
// Limbs hang along -z in the zero pose; joint signs follow MuJoCo's right-hand rule:
//   hinge about +y with a negative angle swings a hanging limb forward (+x).
import type { GeomRole, HydraulicCircuit, JointDef, MaterialId, PartDef, PartTag, RobotDesign, Vec3 } from '../core/types';
import { motor } from './catalog';

export interface HumanoidSpec {
  id: string;
  name: string;
  tagline: string;
  scale: number; // 1.0 ≈ 1.95 m standing height
  bulk: number; // 1.0 = athletic, 1.4 = heavyweight (widens armor and limbs)
  armor: MaterialId;
  frame: MaterialId;
  motors: { leg: string; knee: string; arm: string; elbow: string; waist: string; neck: string };
  fist: 'block' | 'spiked' | 'piston';
  head: 'visor' | 'dome' | 'slit' | 'twin';
  gyro: { maxTorqueNm: number; momentumNms: number; massKg: number } | null;
  hydraulicArms: boolean;
  /** Legs and waist driven off one hydraulic circuit ('legs'): puncture a thigh or shin and they sag. */
  hydraulicLegs?: boolean;
  headBreakImpulseNs: number;
  eyeColor: string;
  abilities: RobotDesign['abilities'];
  defaultSkin: RobotDesign['defaultSkin'];
}

const DEG = Math.PI / 180;
/** Position servos reach stall torque at this error (~4°): stiff enough to swing a heavy leg
 *  precisely; kv damping scales with kp and is integrated implicitly by MuJoCo. */
const SERVO_FULL_TORQUE_ERROR_RAD = 0.07;
/** Ankles press the sole against the canvas: stiffer than this and they chatter on contact. */
const ANKLE_FULL_TORQUE_ERROR_RAD = 0.1;

function hinge(name: string, axis: Vec3, rangeDeg: [number, number], motorId: string, extra: Partial<JointDef> = {}, fullTorqueErrorRad = SERVO_FULL_TORQUE_ERROR_RAD): JointDef {
  const spec = motor(motorId);
  const kp = spec.stallTorqueNm / fullTorqueErrorRad;
  return {
    name, type: 'hinge', axis, rangeDeg, motor: motorId,
    kp, kd: kp * 0.045,
    armature: 0.02 + spec.massKg * 0.01,
    damping: 0.5,
    frictionloss: spec.stallTorqueNm * 0.004,
    ...extra,
  };
}

function side(tag: 'l' | 'r'): { s: number; t: PartTag } {
  return tag === 'l' ? { s: 1, t: 'left' } : { s: -1, t: 'right' };
}

export function buildHumanoid(spec: HumanoidSpec): RobotDesign {
  const k = spec.scale;
  const b = spec.bulk;
  const L = {
    pelvisHalf: [0.13 * k * b, 0.17 * k * b, 0.09 * k] as Vec3,
    torsoHalf: [0.17 * k * b, 0.25 * k * b, 0.24 * k] as Vec3,
    torsoCenterZ: 0.3 * k,
    shoulderY: 0.31 * k * b,
    shoulderZ: 0.44 * k,
    upperArm: 0.3 * k,
    foreArm: 0.28 * k,
    armR: 0.055 * k * b,
    fistHalf: 0.075 * k * Math.sqrt(b),
    hipY: 0.12 * k * b,
    thigh: 0.44 * k,
    shin: 0.44 * k,
    legR: 0.075 * k * b,
    footHalf: [0.15 * k, 0.075 * k * Math.sqrt(b), 0.035 * k] as Vec3,
    neckZ: 0.56 * k,
    headHalf: [0.11 * k, 0.1 * k, 0.12 * k] as Vec3,
  };
  const rootHeight = L.thigh + L.shin + 2 * L.footHalf[2] + L.pelvisHalf[2] + 0.04 * k;
  const role = (r: GeomRole) => r;
  // Only joints actually driven by a hydraulic actuator hang off the leg circuit.
  const onLegCircuit = (motorId: string): Partial<JointDef> =>
    spec.hydraulicLegs && motor(motorId).kind === 'hydraulic' ? { hydraulicCircuit: 'legs' } : {};
  const legTags: PartTag[] = spec.hydraulicLegs ? ['hydraulic'] : [];
  const parts: PartDef[] = [];

  parts.push({
    id: 'pelvis', pos: [0, 0, 0], tags: ['pelvis'], hp: 900,
    geoms: [{ shape: { type: 'box', halfSize: L.pelvisHalf }, material: spec.frame, role: role('structure') }],
    visual: { kit: 'pelvis.block' },
    smokePoint: [-L.pelvisHalf[0], 0, 0],
  });

  const torsoTags: PartTag[] = spec.gyro ? ['torso', 'gyro'] : ['torso'];
  parts.push({
    id: 'torso', parent: 'pelvis', pos: [0, 0, L.pelvisHalf[2]], tags: torsoTags, hp: 1400,
    joints: [
      hinge('waist_yaw', [0, 0, 1], [-70, 70], spec.motors.waist, onLegCircuit(spec.motors.waist)),
      // Deep forward fold: getting up off the canvas needs knees to chest and a torso over the feet.
      hinge('waist_pitch', [0, 1, 0], [-25, 50], spec.motors.waist, onLegCircuit(spec.motors.waist)),
    ],
    geoms: [
      { shape: { type: 'box', halfSize: L.torsoHalf }, pos: [0, 0, L.torsoCenterZ], material: spec.armor, role: 'armor' },
    ],
    visual: { kit: 'torso.chest', params: { gyro: !!spec.gyro } },
    smokePoint: [-L.torsoHalf[0], 0, L.torsoCenterZ + L.torsoHalf[2] * 0.7],
  });

  parts.push({
    id: 'head', parent: 'torso', pos: [0, 0, L.neckZ], tags: ['head', 'sensor'], hp: 300,
    joints: [hinge('neck_yaw', [0, 0, 1], [-80, 80], spec.motors.neck)],
    geoms: [{ shape: { type: 'box', halfSize: L.headHalf }, pos: [0, 0, L.headHalf[2]], material: spec.armor, role: 'sensor' }],
    visual: { kit: `head.${spec.head}` },
    detachable: { impulseNs: spec.headBreakImpulseNs, damage: 150 },
    smokePoint: [0, 0, L.headHalf[2] * 2],
  });

  for (const tag of ['l', 'r'] as const) {
    const { s, t } = side(tag);
    parts.push({
      id: `upperarm_${tag}`, parent: 'torso', pos: [0, s * L.shoulderY, L.shoulderZ], tags: ['upperarm', t], hp: 500,
      joints: [
        hinge(`shoulder_pitch_${tag}`, [0, 1, 0], [-170, 50], spec.motors.arm),
        hinge(`shoulder_roll_${tag}`, [1, 0, 0], tag === 'l' ? [-15, 100] : [-100, 15], spec.motors.arm),
        hinge(`shoulder_yaw_${tag}`, [0, 0, 1], [-80, 80], spec.motors.arm),
      ],
      geoms: [{ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.upperArm], radius: L.armR * 1.15 }, material: spec.frame, role: 'structure' }],
      visual: { kit: 'arm.upper', params: { hydraulic: spec.hydraulicArms } },
    });
    parts.push({
      id: `forearm_${tag}`, parent: `upperarm_${tag}`, pos: [0, 0, -L.upperArm], tags: ['forearm', t, ...(spec.hydraulicArms ? ['hydraulic' as PartTag] : [])], hp: 450,
      joints: [hinge(`elbow_${tag}`, [0, 1, 0], [-150, 0], spec.hydraulicArms ? 'hyd.cyl32' : spec.motors.elbow,
        spec.hydraulicArms ? { hydraulicCircuit: 'arms' } : {})],
      geoms: [{ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.foreArm], radius: L.armR * 1.25 }, material: spec.armor, role: 'armor' }],
      visual: { kit: 'arm.fore', params: { hydraulic: spec.hydraulicArms } },
      smokePoint: [0, 0, -L.foreArm * 0.3],
    });
    parts.push({
      id: `fist_${tag}`, parent: `forearm_${tag}`, pos: [0, 0, -L.foreArm - L.fistHalf], tags: ['fist', t], hp: 700,
      geoms: [{ shape: { type: 'box', halfSize: [L.fistHalf, L.fistHalf * 0.9, L.fistHalf] }, material: 'ar500', role: 'striker' }],
      visual: { kit: `fist.${spec.fist}` },
    });
    parts.push({
      id: `thigh_${tag}`, parent: 'pelvis', pos: [0, s * L.hipY, -L.pelvisHalf[2]], tags: ['thigh', t, ...legTags], hp: 700,
      joints: [
        hinge(`hip_yaw_${tag}`, [0, 0, 1], [-40, 40], spec.motors.leg, onLegCircuit(spec.motors.leg)),
        hinge(`hip_roll_${tag}`, [1, 0, 0], tag === 'l' ? [-20, 45] : [-45, 20], spec.motors.leg, onLegCircuit(spec.motors.leg)),
        hinge(`hip_pitch_${tag}`, [0, 1, 0], [-135, 35], spec.motors.leg, onLegCircuit(spec.motors.leg)),
      ],
      geoms: [{ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.thigh], radius: L.legR * 1.15 }, material: spec.frame, role: 'structure' }],
      visual: { kit: 'leg.thigh' },
      smokePoint: [0, 0, -L.thigh * 0.2],
    });
    parts.push({
      id: `shin_${tag}`, parent: `thigh_${tag}`, pos: [0, 0, -L.thigh], tags: ['shin', t, ...legTags], hp: 650,
      joints: [hinge(`knee_${tag}`, [0, 1, 0], [0, 150], spec.motors.knee, onLegCircuit(spec.motors.knee))],
      // The capsule stops one radius short of the ankle so its end cap never reaches below the
      // sole: a heavy biped must stand on its feet, not on its ankle balls.
      geoms: [{ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -(L.shin - L.legR)], radius: L.legR }, material: spec.armor, role: 'armor' }],
      visual: { kit: 'leg.shin' },
      smokePoint: [0, 0, -0.05],
    });
    parts.push({
      id: `foot_${tag}`, parent: `shin_${tag}`, pos: [0, 0, -L.shin], tags: ['foot', t], hp: 600,
      joints: [
        hinge(`ankle_pitch_${tag}`, [0, 1, 0], [-60, 45], spec.motors.leg, onLegCircuit(spec.motors.leg), ANKLE_FULL_TORQUE_ERROR_RAD),
        hinge(`ankle_roll_${tag}`, [1, 0, 0], [-30, 30], spec.motors.leg, onLegCircuit(spec.motors.leg), ANKLE_FULL_TORQUE_ERROR_RAD),
      ],
      geoms: [{ shape: { type: 'box', halfSize: L.footHalf }, pos: [L.footHalf[0] * 0.35, 0, -L.footHalf[2] - 0.02 * k], material: 'rubber', role: 'foot' }],
      visual: { kit: 'leg.foot' },
    });
  }

  const stance: Record<string, number> = {
    waist_yaw: 0, waist_pitch: 0.08, neck_yaw: 0,
  };
  for (const tag of ['l', 'r'] as const) {
    const s = tag === 'l' ? 1 : -1;
    Object.assign(stance, {
      [`shoulder_pitch_${tag}`]: -0.85,
      [`shoulder_roll_${tag}`]: s * 0.18,
      [`shoulder_yaw_${tag}`]: s * 0.25,
      [`elbow_${tag}`]: -1.95,
      [`hip_yaw_${tag}`]: 0,
      [`hip_roll_${tag}`]: s * 0.04,
      [`hip_pitch_${tag}`]: -0.32,
      [`knee_${tag}`]: 0.62,
      [`ankle_pitch_${tag}`]: -0.3,
      [`ankle_roll_${tag}`]: -s * 0.04,
    });
  }

  return {
    id: spec.id,
    name: spec.name,
    tagline: spec.tagline,
    bodyType: 'biped',
    parts,
    hydraulics: hydraulicCircuits(spec),
    gyro: spec.gyro ? { part: 'torso', ...spec.gyro, powerW: spec.gyro.maxTorqueNm * 4 } : undefined,
    abilities: spec.abilities,
    stance,
    rootHeight: rootHeight * 0.97,
    defaultSkin: spec.defaultSkin,
    eyeColor: spec.eyeColor,
  };
}

function hydraulicCircuits(spec: HumanoidSpec): HydraulicCircuit[] | undefined {
  const out: HydraulicCircuit[] = [];
  if (spec.hydraulicArms) out.push({ id: 'arms', pressureBar: 210, reservoirL: 6, leakLPerSAtFullDamage: 0.35, parts: ['forearm_l', 'forearm_r'] });
  if (spec.hydraulicLegs) out.push({ id: 'legs', pressureBar: 210, reservoirL: 14, leakLPerSAtFullDamage: 0.5, parts: ['thigh_l', 'thigh_r', 'shin_l', 'shin_r'] });
  return out.length ? out : undefined;
}

export const DEG_TO_RAD = DEG;
