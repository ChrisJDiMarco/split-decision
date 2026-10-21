// Parametric humanoid fighter. Local frame: x forward, y left, z up.
// Limbs hang along -z in the zero pose; joint signs follow MuJoCo's right-hand rule:
//   hinge about +y with a negative angle swings a hanging limb forward (+x).
import type { DesignPalette, Era, GeomDef, GeomRole, HydraulicCircuit, JointDef, MaterialId, MotorSpec, PartDef, PartTag, RobotDesign, Vec3, WeightClass } from '../core/types';
import { MATERIALS, motor, reflectedInertia } from './catalog';
import { geomArea, geomVolume } from './compile-mjcf';

/** Multipliers on the builder's segment ratios (1 = the iron-age proportions). */
export interface HumanoidProportions {
  torso: number; // torso height: waist to neck, shoulder height
  arms: number; // upper arm and forearm length
  legs: number; // thigh and shin length
  shoulders: number; // shoulder-joint span and chest width
  hips: number; // hip-joint span and pelvis width
  head: number; // head size
}

/**
 * Per-design mass model (replaces the catalog's global wall thicknesses and fill for this design).
 * A shell part weighs its surface area × wall thickness × density plus volume × internal fill
 * (wiring, drivers, brackets, battery cells in the torso). Motors and the gyro core come on top.
 */
export interface HumanoidShell {
  armorMm: number; // armour shells (torso, forearms, shins)
  frameMm: number; // structural tubes and pelvis (upper arms, thighs)
  headMm: number; // head shell
  fillKgM3: number; // internal fill of hollow parts
  torsoFillKgM3: number; // the torso holds the battery and compute: denser
  footFill: number; // solid fraction of the foot box (sole, ankle linkage)
  /** Bare fists: a hollow aluminium hand (solid fraction handFill) behind a hardened knuckle plate. */
  handFill: number;
  knucklePlateMm: number;
}

export interface HumanoidSpec {
  id: string;
  name: string;
  tagline: string;
  scale: number; // 1.0 ≈ 1.95 m standing height
  bulk: number; // 1.0 = athletic, 1.4 = heavyweight (widens armor and limbs)
  armor: MaterialId;
  frame: MaterialId;
  /**
   * Actuators by joint group. The optional per-joint entries override their group for one joint (a
   * stronger module where one joint is the bottleneck, docs/research/08-modern-roster.md); left out,
   * the design compiles exactly as before. `ankle` is the ankles' own group (pitch and roll; `ankleRoll`
   * may split roll off it); without it the ankles run on `leg`, as the iron age does.
   */
  motors: {
    leg: string; knee: string; arm: string; elbow: string; waist: string; neck: string;
    shoulderPitch?: string; waistYaw?: string; hipPitch?: string; hipYaw?: string; hipRoll?: string;
    ankle?: string; ankleRoll?: string;
  };
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
  // Modern-roster fields. All optional: leaving them out builds the iron-age designs unchanged.
  proportions?: Partial<HumanoidProportions>;
  /** robot-kit recipe ids for PartVisual.kit (override head / fist above for the renderer). */
  look?: { head: string; torso: string; fist: string; shin?: string; foot?: string };
  /** Padded boxing gloves: the fists become rounded 'glove' strikers. ounces sets the glove mass. */
  gloves?: { color: string; ounces?: number };
  palette?: DesignPalette;
  weightClass?: WeightClass;
  era?: Era;
  shell?: HumanoidShell;
}

const DEG = Math.PI / 180;

/**
 * Joint ranges in degrees. Roll and yaw ranges are given for the LEFT side; the right side is the
 * mirror image (right = [−hi, −lo]), so a mirrored (southpaw) move stays inside the right side's
 * range exactly when the orthodox one stays inside the left's.
 */
interface JointRanges {
  waistYaw: [number, number];
  waistPitch: [number, number]; // + folds forward
  neckYaw: [number, number];
  shoulderPitch: [number, number]; // − swings the arm forward and up, + back
  shoulderRoll: [number, number]; // left: + abducts (out to the side), − crosses the chest
  shoulderYaw: [number, number];
  elbow: [number, number];
  hipYaw: [number, number]; // left: + turns the foot out (external rotation)
  hipRoll: [number, number]; // left: + abducts (legs apart), − crosses the other leg
  hipPitch: [number, number]; // − lifts the knee forward
  knee: [number, number];
  anklePitch: [number, number]; // + points the toes (plantarflexion), − pulls them up
  ankleRoll: [number, number];
}

/** The iron-age heavyweights keep the ranges they were built with (their compiled MJCF is frozen). */
const IRON_RANGES: JointRanges = {
  waistYaw: [-70, 70], waistPitch: [-25, 50], neckYaw: [-80, 80],
  shoulderPitch: [-170, 50], shoulderRoll: [-15, 100], shoulderYaw: [-80, 80], elbow: [-150, 0],
  hipYaw: [-40, 40], hipRoll: [-20, 45], hipPitch: [-135, 35], knee: [0, 150],
  anklePitch: [-60, 45], ankleRoll: [-30, 30],
};

/**
 * The modern electric designs (2026-09-29, for the mocap tracking controller). Widened where the
 * retargeted CMU moves sat on a limit (share of joint-frames on the limit in the built savate and
 * firecracker libraries before the change), and only as far as a QDD/planetary joint with a hollow
 * shaft can plausibly turn (Unitree G1: hip yaw ±157°, hip roll −30…170°, waist yaw ±150°):
 *   waist yaw     ±70 → ±90      spinning back kicks and backfists wind the chest past 70°
 *   waist pitch   −25…50 → −35…80    get-ups sat on the 50° fold on 21-25% of frames (sitting up
 *                                  off the back, chest over the knees); −35 arches a kip-up
 *   shoulder pitch −170…50 → −180…70   pushing off the mat behind the body hit +50 on 4-8%
 *   shoulder roll −15…100 → −35…130    arms reaching across the chest (side get-ups, hook
 *                                  follow-through) hit the 15° adduction limit on 7%; 130° lifts
 *                                  the arms overhead for handsprings and the victory
 *   shoulder yaw  ±80 → ±95       hit on 3-4% of get-up frames
 *   hip yaw       ±40 → −45…70    external rotation was on its limit on 14-26% of kick frames
 *                                  (the chamber, the stance foot's pivot) and 14-27% of get-up
 *                                  frames (frog-legged knee-outs); internal rotation stays human
 *   hip roll      −20…45 → −35…70     a leg crossing over in a side roll hit the 20° adduction
 *                                  limit on 6-13%; the actor's splits and frog positions need
 *                                  abduction past 45°
 *   hip pitch     −135 → −145     knees to the chest in a get-up tuck (4-5% on the limit)
 *   ankle pitch   45 → 60 (toes)  kneeling on pointed feet (5-8% on the limit)
 *   ankle roll    ±30 → ±40       rolled feet in side get-ups and a kick's pivot (8-12% / 3-8%)
 * Knee, elbow and neck ranges were never the limit and are unchanged.
 */
const MODERN_RANGES: JointRanges = {
  waistYaw: [-90, 90], waistPitch: [-35, 80], neckYaw: [-80, 80],
  shoulderPitch: [-180, 70], shoulderRoll: [-35, 130], shoulderYaw: [-95, 95], elbow: [-150, 0],
  hipYaw: [-45, 70], hipRoll: [-35, 70], hipPitch: [-145, 35], knee: [0, 150],
  anklePitch: [-60, 60], ankleRoll: [-40, 40],
};

/** Range for side `tag` of a roll or yaw joint given for the left side. */
const mirrored = (tag: 'l' | 'r', [lo, hi]: [number, number]): [number, number] => (tag === 'l' ? [lo, hi] : [-hi, -lo]);

/** Position servos reach stall torque at this error (~4°): stiff enough to swing a heavy leg
 *  precisely; kv damping scales with kp and is integrated implicitly by MuJoCo. */
const SERVO_FULL_TORQUE_ERROR_RAD = 0.07;
/** Ankles press the sole against the canvas: stiffer than this and they chatter on contact. */
const ANKLE_FULL_TORQUE_ERROR_RAD = 0.1;

/**
 * Modern joints carry their drive train's real reflected rotor inertia as armature (rotor × ratio²,
 * the value the damage model's joint loads use; docs/design/robot-realism-pass.md §1), down to this
 * floor for solver margin. Every limb drive in the catalog reflects more (the lightest, a RobStride 06,
 * 0.0049 kg·m²); only the neck drives (RobStride 00 / 02, 0.0015-0.0021) are lifted to it.
 */
export const ARMATURE_FLOOR_KG_M2 = 0.004;

/** The armature a modern joint gets for this drive. */
export function modernArmature(spec: MotorSpec): number {
  const reflected = reflectedInertia(spec);
  // A drive with no published or derivable rotor inertia keeps the old placeholder (none today).
  return reflected === undefined ? 0.02 + spec.massKg * 0.01 : Math.max(ARMATURE_FLOOR_KG_M2, reflected);
}

/**
 * Modern drives mounted on the parent part (JointDef.mount), as real builds carry them
 * (robot-realism-pass.md §2): the shoulder pitch in the chest, the elbow in the upper arm, the hip yaw
 * in the pelvis, the knee in the thigh (on a linkage) and both ankle drives in the shin (on a parallel
 * linkage, as Unitree G1 / H1-2). The rest stay in the part they move; the neck drive stays in the head.
 */
const PARENT_MOUNTED = /^(shoulder_pitch|elbow|hip_yaw|knee|ankle_pitch|ankle_roll)_[lr]$/;

function hinge(name: string, axis: Vec3, rangeDeg: [number, number], motorId: string, extra: Partial<JointDef> = {}, fullTorqueErrorRad = SERVO_FULL_TORQUE_ERROR_RAD): JointDef {
  const spec = motor(motorId);
  const kp = spec.stallTorqueNm / fullTorqueErrorRad;
  return {
    name, type: 'hinge', axis, rangeDeg: [rangeDeg[0], rangeDeg[1]], motor: motorId,
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

const OUNCE_KG = 0.02835;
const DEFAULT_GLOVE_OZ = 10;
/** A glove is a padded striker this much bigger than the bare fist block it replaces. */
const GLOVE_SIZE_X_FIST = 1.18;

/** Full proportions with defaults. Every factor is exactly 1 unless the spec sets it. */
export function proportionsOf(spec: Pick<HumanoidSpec, 'proportions'>): HumanoidProportions {
  return { torso: 1, arms: 1, legs: 1, shoulders: 1, hips: 1, head: 1, ...spec.proportions };
}

/** Standing height, sole to crown, with straight legs: the sum of the segment chain below. */
export function humanoidHeight(spec: Pick<HumanoidSpec, 'scale' | 'proportions'>): number {
  const p = proportionsOf(spec);
  // sole→ankle 0.09, legs 0.88, hip→pelvis→waist 0.18, waist→neck 0.56, head 0.24 (× scale)
  return spec.scale * (0.27 + 0.88 * p.legs + 0.56 * p.torso + 0.24 * p.head);
}

/** The builder scale that makes a humanoid with these proportions stand heightM tall. */
export function scaleForHeight(heightM: number, proportions?: Partial<HumanoidProportions>): number {
  return heightM / humanoidHeight({ scale: 1, proportions });
}

export function buildHumanoid(spec: HumanoidSpec): RobotDesign {
  const k = spec.scale;
  const b = spec.bulk;
  const P = proportionsOf(spec);
  const R = spec.era === 'modern' ? MODERN_RANGES : IRON_RANGES;
  // Multiplying by an exact 1 is exact in IEEE arithmetic, so designs without proportions compile
  // to the same numbers as before (tests/roster/iron-age.test.ts holds that to the byte).
  const L = {
    pelvisHalf: [0.13 * k * b, 0.17 * k * b * P.hips, 0.09 * k] as Vec3,
    torsoHalf: [0.17 * k * b, 0.25 * k * b * P.shoulders, 0.24 * k * P.torso] as Vec3,
    torsoCenterZ: 0.3 * k * P.torso,
    shoulderY: 0.31 * k * b * P.shoulders,
    shoulderZ: 0.44 * k * P.torso,
    upperArm: 0.3 * k * P.arms,
    foreArm: 0.28 * k * P.arms,
    armR: 0.055 * k * b,
    fistHalf: 0.075 * k * Math.sqrt(b),
    hipY: 0.12 * k * b * P.hips,
    thigh: 0.44 * k * P.legs,
    shin: 0.44 * k * P.legs,
    legR: 0.075 * k * b,
    footHalf: [0.15 * k, 0.075 * k * Math.sqrt(b), 0.035 * k] as Vec3,
    neckZ: 0.56 * k * P.torso,
    headHalf: [0.11 * k * P.head, 0.1 * k * P.head, 0.12 * k * P.head] as Vec3,
  };
  const look = spec.look;
  const shell = spec.shell;
  // Per-design mass model: pins each geom's mass (massKg) from this design's shell. Without a
  // shell the catalog's global mass model applies at compile time, as before.
  const weigh = (g: GeomDef, wallMm: number, fillKgM3: number): GeomDef =>
    shell ? { ...g, massKg: geomArea(g) * (wallMm / 1000) * MATERIALS[g.material].densityKgM3 + geomVolume(g) * fillKgM3 } : g;
  const solid = (g: GeomDef, fill: number): GeomDef =>
    shell ? { ...g, massKg: geomVolume(g) * MATERIALS[g.material].densityKgM3 * fill } : g;
  const rootHeight = L.thigh + L.shin + 2 * L.footHalf[2] + L.pelvisHalf[2] + 0.04 * k;
  const role = (r: GeomRole) => r;
  // Only joints actually driven by a hydraulic actuator hang off the leg circuit.
  const onLegCircuit = (motorId: string): Partial<JointDef> =>
    spec.hydraulicLegs && motor(motorId).kind === 'hydraulic' ? { hydraulicCircuit: 'legs' } : {};
  const legTags: PartTag[] = spec.hydraulicLegs ? ['hydraulic'] : [];
  const parts: PartDef[] = [];
  // Modern joints get their drive train's reflected inertia and their drive's real mount; the iron
  // age keeps the placeholder armature and drives in the moved part (its MJCF is frozen to the byte).
  const modern = spec.era === 'modern';
  const joint = (name: string, axis: Vec3, range: [number, number], motorId: string, extra: Partial<JointDef> = {}, fullTorqueErrorRad?: number): JointDef =>
    hinge(name, axis, range, motorId, modern ? { armature: modernArmature(motor(motorId)), ...(PARENT_MOUNTED.test(name) ? { mount: 'parent' as const } : {}), ...extra } : extra, fullTorqueErrorRad);
  const hipRollMotor = spec.motors.hipRoll ?? spec.motors.leg;
  const ankleMotor = spec.motors.ankle ?? spec.motors.leg;
  const ankleRollMotor = spec.motors.ankleRoll ?? ankleMotor;

  parts.push({
    id: 'pelvis', pos: [0, 0, 0], tags: ['pelvis'], hp: 900,
    geoms: [weigh({ shape: { type: 'box', halfSize: L.pelvisHalf }, material: spec.frame, role: role('structure') }, shell?.frameMm ?? 0, shell?.fillKgM3 ?? 0)],
    visual: { kit: 'pelvis.block' },
    smokePoint: [-L.pelvisHalf[0], 0, 0],
  });

  const torsoTags: PartTag[] = spec.gyro ? ['torso', 'gyro'] : ['torso'];
  parts.push({
    id: 'torso', parent: 'pelvis', pos: [0, 0, L.pelvisHalf[2]], tags: torsoTags, hp: 1400,
    joints: [
      joint('waist_yaw', [0, 0, 1], R.waistYaw, spec.motors.waistYaw ?? spec.motors.waist, onLegCircuit(spec.motors.waistYaw ?? spec.motors.waist)),
      // Deep forward fold: getting up off the canvas needs knees to chest and a torso over the feet.
      joint('waist_pitch', [0, 1, 0], R.waistPitch, spec.motors.waist, onLegCircuit(spec.motors.waist)),
    ],
    geoms: [
      weigh({ shape: { type: 'box', halfSize: L.torsoHalf }, pos: [0, 0, L.torsoCenterZ], material: spec.armor, role: 'armor' }, shell?.armorMm ?? 0, shell?.torsoFillKgM3 ?? 0),
    ],
    visual: { kit: look?.torso ?? 'torso.chest', params: { gyro: !!spec.gyro } },
    smokePoint: [-L.torsoHalf[0], 0, L.torsoCenterZ + L.torsoHalf[2] * 0.7],
  });

  parts.push({
    id: 'head', parent: 'torso', pos: [0, 0, L.neckZ], tags: ['head', 'sensor'], hp: 300,
    joints: [joint('neck_yaw', [0, 0, 1], R.neckYaw, spec.motors.neck)],
    geoms: [weigh({ shape: { type: 'box', halfSize: L.headHalf }, pos: [0, 0, L.headHalf[2]], material: spec.armor, role: 'sensor' }, shell?.headMm ?? 0, shell?.fillKgM3 ?? 0)],
    visual: { kit: look?.head ?? `head.${spec.head}` },
    detachable: { impulseNs: spec.headBreakImpulseNs, damage: 150 },
    smokePoint: [0, 0, L.headHalf[2] * 2],
  });

  for (const tag of ['l', 'r'] as const) {
    const { s, t } = side(tag);
    parts.push({
      id: `upperarm_${tag}`, parent: 'torso', pos: [0, s * L.shoulderY, L.shoulderZ], tags: ['upperarm', t], hp: 500,
      joints: [
        joint(`shoulder_pitch_${tag}`, [0, 1, 0], R.shoulderPitch, spec.motors.shoulderPitch ?? spec.motors.arm),
        joint(`shoulder_roll_${tag}`, [1, 0, 0], mirrored(tag, R.shoulderRoll), spec.motors.arm),
        joint(`shoulder_yaw_${tag}`, [0, 0, 1], mirrored(tag, R.shoulderYaw), spec.motors.arm),
      ],
      geoms: [weigh({ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.upperArm], radius: L.armR * 1.15 }, material: spec.frame, role: 'structure' }, shell?.frameMm ?? 0, shell?.fillKgM3 ?? 0)],
      visual: { kit: 'arm.upper', params: { hydraulic: spec.hydraulicArms } },
    });
    parts.push({
      id: `forearm_${tag}`, parent: `upperarm_${tag}`, pos: [0, 0, -L.upperArm], tags: ['forearm', t, ...(spec.hydraulicArms ? ['hydraulic' as PartTag] : [])], hp: 450,
      joints: [joint(`elbow_${tag}`, [0, 1, 0], R.elbow, spec.hydraulicArms ? 'hyd.cyl32' : spec.motors.elbow,
        spec.hydraulicArms ? { hydraulicCircuit: 'arms' } : {})],
      geoms: [weigh({ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.foreArm], radius: L.armR * 1.25 }, material: spec.armor, role: 'armor' }, shell?.armorMm ?? 0, shell?.fillKgM3 ?? 0)],
      visual: { kit: 'arm.fore', params: { hydraulic: spec.hydraulicArms } },
      smokePoint: [0, 0, -L.foreArm * 0.3],
    });
    parts.push({
      id: `fist_${tag}`, parent: `forearm_${tag}`, pos: [0, 0, -L.foreArm - L.fistHalf], tags: ['fist', t], hp: 700,
      geoms: [fistGeom(spec, L.fistHalf)],
      visual: spec.gloves
        ? { kit: look?.fist ?? 'fist.glove', params: { color: spec.gloves.color } }
        : { kit: look?.fist ?? `fist.${spec.fist}` },
    });
    parts.push({
      id: `thigh_${tag}`, parent: 'pelvis', pos: [0, s * L.hipY, -L.pelvisHalf[2]], tags: ['thigh', t, ...legTags], hp: 700,
      joints: [
        joint(`hip_yaw_${tag}`, [0, 0, 1], mirrored(tag, R.hipYaw), spec.motors.hipYaw ?? spec.motors.leg, onLegCircuit(spec.motors.hipYaw ?? spec.motors.leg)),
        joint(`hip_roll_${tag}`, [1, 0, 0], mirrored(tag, R.hipRoll), hipRollMotor, onLegCircuit(hipRollMotor)),
        joint(`hip_pitch_${tag}`, [0, 1, 0], R.hipPitch, spec.motors.hipPitch ?? spec.motors.leg, onLegCircuit(spec.motors.hipPitch ?? spec.motors.leg)),
      ],
      geoms: [weigh({ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -L.thigh], radius: L.legR * 1.15 }, material: spec.frame, role: 'structure' }, shell?.frameMm ?? 0, shell?.fillKgM3 ?? 0)],
      visual: { kit: 'leg.thigh' },
      smokePoint: [0, 0, -L.thigh * 0.2],
    });
    parts.push({
      id: `shin_${tag}`, parent: `thigh_${tag}`, pos: [0, 0, -L.thigh], tags: ['shin', t, ...legTags], hp: 650,
      joints: [joint(`knee_${tag}`, [0, 1, 0], R.knee, spec.motors.knee, onLegCircuit(spec.motors.knee))],
      // The capsule stops one radius short of the ankle so its end cap never reaches below the
      // sole: a heavy biped must stand on its feet, not on its ankle balls.
      geoms: [weigh({ shape: { type: 'capsule', from: [0, 0, 0], to: [0, 0, -(L.shin - L.legR)], radius: L.legR }, material: spec.armor, role: 'armor' }, shell?.armorMm ?? 0, shell?.fillKgM3 ?? 0)],
      visual: { kit: look?.shin ?? 'leg.shin' },
      smokePoint: [0, 0, -0.05],
    });
    parts.push({
      id: `foot_${tag}`, parent: `shin_${tag}`, pos: [0, 0, -L.shin], tags: ['foot', t], hp: 600,
      joints: [
        joint(`ankle_pitch_${tag}`, [0, 1, 0], R.anklePitch, ankleMotor, onLegCircuit(ankleMotor), ANKLE_FULL_TORQUE_ERROR_RAD),
        joint(`ankle_roll_${tag}`, [1, 0, 0], mirrored(tag, R.ankleRoll), ankleRollMotor, onLegCircuit(ankleRollMotor), ANKLE_FULL_TORQUE_ERROR_RAD),
      ],
      geoms: [solid({ shape: { type: 'box', halfSize: L.footHalf }, pos: [L.footHalf[0] * 0.35, 0, -L.footHalf[2] - 0.02 * k], material: 'rubber', role: 'foot' }, shell?.footFill ?? 0)],
      visual: { kit: look?.foot ?? 'leg.foot' },
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
    // Only set when given, so the iron-age designs keep exactly their old shape.
    ...(spec.palette ? { palette: spec.palette } : {}),
    ...(spec.gloves ? { gloves: { color: spec.gloves.color } } : {}),
    ...(spec.weightClass ? { weightClass: spec.weightClass } : {}),
    ...(spec.era ? { era: spec.era } : {}),
  };
}

/**
 * The striker at the end of each forearm. Bare: the builder's AR500 block (hard, sparks). Gloved:
 * a padded glove a little bigger than the fist, leather over foam around an aluminium hand, so a
 * glove keeps the punch's impulse but hits soft (CUSHION_MATERIALS in the damage model). The glove's
 * collision shape stays a box with the fist's proportions because the controller measures reach
 * from the fist box (physics/control/geometry.ts); the render kit draws it rounded ('fist.glove').
 */
function fistGeom(spec: HumanoidSpec, fistHalf: number): GeomDef {
  const block: GeomDef = { shape: { type: 'box', halfSize: [fistHalf, fistHalf * 0.9, fistHalf] }, material: 'ar500', role: 'striker' };
  const shell = spec.shell;
  // Hollow aluminium hand, the solid share of the fist block.
  const handKg = shell ? geomVolume(block) * MATERIALS.al7075.densityKgM3 * shell.handFill : 0;
  if (spec.gloves) {
    const gloveKg = (spec.gloves.ounces ?? DEFAULT_GLOVE_OZ) * OUNCE_KG;
    const g = fistHalf * GLOVE_SIZE_X_FIST;
    const glove: GeomDef = { shape: { type: 'box', halfSize: [g, g * 0.9, g] }, material: 'glove', role: 'striker' };
    return { ...glove, massKg: (shell ? handKg : geomVolume(block) * MATERIALS.al7075.densityKgM3 * 0.14) + gloveKg };
  }
  if (!shell) return block;
  // Knuckle plate: the front face of the block (the face that lands, 2·hx × 2·hy) in AR500.
  const plateKg = 4 * fistHalf * (fistHalf * 0.9) * (shell.knucklePlateMm / 1000) * MATERIALS.ar500.densityKgM3;
  return { ...block, massKg: handKg + plateKg };
}

function hydraulicCircuits(spec: HumanoidSpec): HydraulicCircuit[] | undefined {
  const out: HydraulicCircuit[] = [];
  if (spec.hydraulicArms) out.push({ id: 'arms', pressureBar: 210, reservoirL: 6, leakLPerSAtFullDamage: 0.35, parts: ['forearm_l', 'forearm_r'] });
  if (spec.hydraulicLegs) out.push({ id: 'legs', pressureBar: 210, reservoirL: 14, leakLPerSAtFullDamage: 0.5, parts: ['thigh_l', 'thigh_r', 'shin_l', 'shin_r'] });
  return out.length ? out : undefined;
}

export const DEG_TO_RAD = DEG;
