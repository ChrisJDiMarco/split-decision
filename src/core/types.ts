// Shared contracts between the physics worker, the brain and the renderer.
// Units are SI (m, kg, s, N, N·m, rad) unless a name says otherwise.
// Quaternions use MuJoCo order: [w, x, y, z].

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Corner = 0 | 1; // 0 = red, 1 = blue

// ---------------------------------------------------------------- materials

export type MaterialId =
  | 'ar500' // abrasion-resistant armor steel
  | 'steel' // mild structural steel
  | 'al6061'
  | 'al7075'
  | 'ti6al4v'
  | 'uhmw'
  | 'polycarb'
  | 'carbon'
  | 'rubber'
  | 'glove'; // boxing glove: leather over foam, a cushioned striker

export interface MaterialSpec {
  id: MaterialId;
  name: string;
  densityKgM3: number;
  yieldMPa: number;
  brinell: number; // hardness, used to scale dent depth and spark intensity
  friction: number; // sliding friction coefficient against canvas / metal
  sparks: boolean; // does a hard hit throw sparks
}

// ---------------------------------------------------------------- actuators

export type MotorKind = 'electric' | 'hydraulic' | 'pneumatic';

/** A real purchasable actuator (or a close analog), expressed at the joint output. */
export interface MotorSpec {
  id: string;
  name: string;
  kind: MotorKind;
  stallTorqueNm: number; // peak output torque at zero speed
  noLoadSpeedRadS: number; // output speed at zero torque
  massKg: number;
  heatCapacityJPerK: number;
  thermalResistanceKPerW: number; // winding-to-ambient
  maxTempC: number; // derating starts ~20 C below, burnout above
  copperLossAtStallW: number; // I^2R at stall; scales with (torque/stall)^2
  source?: string; // spec sheet / product the numbers come from
}

// ---------------------------------------------------------------- geometry

export type GeomShape =
  | { type: 'box'; halfSize: Vec3 }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; from: Vec3; to: Vec3; radius: number }
  | { type: 'cylinder'; from: Vec3; to: Vec3; radius: number };

export type GeomRole = 'structure' | 'armor' | 'striker' | 'foot' | 'wheel' | 'sensor' | 'weapon';

export interface GeomDef {
  shape: GeomShape;
  pos?: Vec3; // only for box / sphere; capsule and cylinder use from/to
  quat?: Quat;
  material: MaterialId;
  massKg?: number; // overrides density-based mass
  role: GeomRole;
}

// ---------------------------------------------------------------- parts

export type PartTag =
  | 'pelvis' | 'torso' | 'head' | 'neck'
  | 'upperarm' | 'forearm' | 'fist' | 'shield' | 'hammer'
  | 'thigh' | 'shin' | 'foot'
  | 'chassis' | 'wheel' | 'leg' | 'jaw' | 'spinner'
  | 'gyro' | 'hydraulic' | 'armor' | 'sensor'
  | 'left' | 'right' | 'front' | 'rear'
  | 'finger'; // a phalanx of a dexterous hand: rides on the fist (palm) part for damage

export interface JointDef {
  name: string; // unique within the robot, e.g. 'knee_l'
  type: 'hinge' | 'slide';
  axis: Vec3; // in the child body frame
  rangeDeg: [number, number]; // for slide joints: metres
  motor: string; // MotorSpec id from the catalog
  gear?: number; // extra reduction on top of the catalog spec (default 1)
  kp: number; // servo stiffness (N·m/rad)
  kd: number; // servo damping (N·m·s/rad)
  armature?: number; // reflected rotor inertia (kg·m²)
  damping?: number; // passive viscous damping
  frictionloss?: number; // dry friction (N·m)
  hydraulicCircuit?: string; // joints powered by a hydraulic circuit lose torque with pressure
  /**
   * A passive joint with no servo of its own, moved through a tendon (RobotDesign.tendons) against a
   * return spring: the underactuated finger joints of a dexterous hand. `motor` then names the drive
   * that pulls the tendon (its mass is counted once, on the tendon, not per joint).
   */
  passive?: { stiffness: number; springRefDeg?: number };
}

/**
 * A fixed tendon: length = Σ coef·q over its joints, pulled by one position actuator (a grip drive).
 * Force at the tendon is in the drive's output units (N·m at the spool); each joint feels coef × it.
 */
export interface TendonDef {
  id: string; // unique within the robot, e.g. 'grip_l'
  joints: Array<{ joint: string; coef: number }>;
  motor: string; // MotorSpec id of the drive
  kp: number; // N·m per rad of tendon length error
  kd: number;
  /** Tendons only pull: the drive's force range is [pullOnly ? 0 : −stall, stall]. */
  pullOnly?: boolean;
  lengthRange: [number, number]; // actuator ctrl range, rad of tendon length
}

export interface BreakSpec {
  impulseNs: number; // a single hit above this impulse on the part pops it off
  damage: number; // accumulated damage points that also pop it off
}

export interface PartVisual {
  kit: string; // render-kit recipe id, e.g. 'head.visor', 'fist.block'
  params?: Record<string, number | string | boolean>;
}

export interface PartDef {
  id: string; // unique within the robot
  parent?: string; // omitted only for the root part
  pos: Vec3; // body origin in the parent body frame
  quat?: Quat;
  joints?: JointDef[]; // 0-3 joints between this part and its parent; none = rigid
  geoms: GeomDef[];
  visual: PartVisual;
  tags: PartTag[];
  hp: number; // structural hit points; joint health is tracked separately
  detachable?: BreakSpec;
  smokePoint?: Vec3; // where smoke and sparks vent, in the part frame
}

export interface HydraulicCircuit {
  id: string;
  pressureBar: number; // nominal
  reservoirL: number;
  leakLPerSAtFullDamage: number;
  parts: string[]; // parts whose damage punctures this circuit
}

export interface GyroSpec {
  part: string; // part that houses the gyro core
  maxTorqueNm: number; // peak stabilizing torque (pitch and roll)
  momentumNms: number; // stored momentum before saturation
  powerW: number;
  massKg: number;
}

export type AbilityId =
  | 'jab' | 'cross' | 'hook' | 'uppercut' | 'overhand' | 'front_kick' | 'low_kick' | 'head_kick'
  | 'hammer_smash' | 'shield_bash' | 'rocket_punch' | 'jaw_crush' | 'lunge' | 'spinner' | 'ram'
  | 'clinch' | 'sprint';

export type BodyType = 'biped' | 'quadruped' | 'wheeled' | 'tracked';

export interface RobotDesign {
  id: string;
  name: string;
  tagline: string;
  bodyType: BodyType;
  parts: PartDef[]; // parts[0] is the root (gets the free joint)
  hydraulics?: HydraulicCircuit[];
  gyro?: GyroSpec;
  abilities: AbilityId[];
  stance: Record<string, number>; // neutral joint targets (rad or m) by joint name
  rootHeight: number; // spawn height of the root part origin
  defaultSkin: SkinId;
  eyeColor: string; // hex, emissive optics
  /** Livery colours for the 'livery' skin (the modern roster's default skin). */
  palette?: DesignPalette;
  /** Padded boxing gloves on the fists (the fist parts are 'glove' strikers). */
  gloves?: { color: string };
  weightClass?: WeightClass;
  era?: Era;
  /** Tendon-driven mechanisms (the grip of a dexterous hand). */
  tendons?: TendonDef[];
  /** Set by applyLoadout on a design built from a non-stock loadout (src/robots/loadout.ts). */
  loadout?: Loadout;
}

// ---------------------------------------------------------------- loadouts (docs/design/loadouts-and-workshop.md)

/**
 * Hands slot. 'stock' is whatever the design was built with; 'glove' padded boxing gloves; 'knuckle'
 * bare fists behind AR500 knuckle plates; 'dexterous' a tendon-driven five-finger hand.
 */
export type HandsOption = 'stock' | 'glove' | 'knuckle' | 'dexterous';

/** A design plus its slot choices. Later slots (head, arms, legs, armour, weapons) add fields here. */
export interface Loadout {
  design: string; // RobotDesign id this loadout is for
  hands: HandsOption;
}

export interface DesignPalette {
  primary: string; // hex, main shell colour
  secondary: string; // hex, frame / second shell colour
  accent: string; // hex, trim, numbers, toe caps
  finish: 'gloss' | 'satin' | 'matte';
}

/**
 * Weight classes, loosely after the WHRG 2026 brackets (40 / 58 / 80 kg): bantam up to 40 kg, middle up
 * to 85 kg, heavy up to 110 kg (the heaviest electric joints can carry), open above (the iron age).
 */
export type WeightClass = 'bantam' | 'middle' | 'heavy' | 'open';
/** 'modern': the all-electric default roster. 'iron': the optional hydraulic heavyweights. */
export type Era = 'modern' | 'iron';

export type SkinId = 'factory' | 'chrome' | 'military' | 'racing' | 'scrapyard' | 'neon' | 'livery'; // livery: the design's own palette

// ---------------------------------------------------------------- match

export interface FighterSetup {
  design: string; // RobotDesign id
  skin: SkinId;
  plan: string; // builder's natural-language fight plan (<= 150 words)
  temperament: number; // 0.3 disciplined .. 1.8 wild (sampling temperature)
  /** Slot choices; omitted (or all 'stock') fights the design as built. */
  loadout?: Loadout;
  /** Who fights this corner: a Jev brain (default) or a human player (src/player). */
  controller?: FighterController;
  /**
   * This corner's own reaction delay (s), overriding MatchSetup.reactionDelayS. A player corner uses
   * PLAYER_REACTION_DELAY_S (src/player/config.ts) so the controls feel responsive; a future 'fair
   * mode' leaves it unset so the human feels Jev's delay too.
   */
  reactionDelayS?: number;
  /**
   * Which mind decides for this corner when it is not the player: cloud Jev (default), a LOCAL
   * open-source Jev-compatible model, or the HOUSE rules. Kept while the corner is the player so
   * picking the mind back restores it. The global MINDS setting (src/core/settings.ts) overrides it.
   */
  mind?: FighterMind;
}

export type FighterController = 'jev' | 'player';
/** Same values as the brain's MindSource (src/brain/types.ts). */
export type FighterMind = 'jev' | 'local' | 'house';

export interface MatchSetup {
  fighters: [FighterSetup, FighterSetup];
  seed: number;
  timestep: number; // physics dt in seconds (0.001 default)
  reactionDelayS: number; // fixed delay before any brain decision takes effect
}
