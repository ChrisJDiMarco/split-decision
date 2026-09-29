// Tuning constants for the damage model. Units are SI unless the name says otherwise.
import type { MaterialId } from '../../core/types';

// ---------------------------------------------------------------- impact detection

/** A contact pair is measured for this long after it first touches; after that it is "spent" until it separates. */
export const IMPACT_WINDOW_S = 0.03;
/** Minimum closing speed (m/s) for a contact to count as a hit, by contact class. */
export const MIN_SPEED_ROBOT_ROBOT = 0.6;
export const MIN_SPEED_ROBOT_WORLD = 1.2;
export const MIN_SPEED_FOOT_CANVAS = 2.5; // footfalls are not hits unless it is a stomp or a fall
export const MIN_SPEED_DEBRIS = 1.0;
export const MIN_SPEED_PROP = 0.5;
/**
 * A pair that is already this deep on first touch was spawned overlapping (debris appearing inside the
 * striker, a teleport): the solver pushing it out is not an impact. A 30 m/s strike moves 3 cm per step.
 */
export const MAX_ENTRY_PENETRATION_M = 0.03;
/** Episodes that deliver less impulse than this are resting contact, not hits. */
export const MIN_EVENT_IMPULSE_NS = 4;
/** Cage event threshold: a robot hitting the fence or a post at this closing speed or more. */
export const CAGE_MIN_SPEED = 1.5;
/** Effective mass of a limb segment: its own mass plus this share of its parent's mass. */
export const CHAIN_MASS_SHARE = 0.5;

// ---------------------------------------------------------------- part damage

/** Damage points per N·s of impulse and per J of closing energy. */
export const IMPULSE_POINTS_PER_NS = 0.25;
export const ENERGY_POINTS_PER_J = 0.04;
/** Striker/victim hardness ratio is raised to this power and clamped. */
export const HARDNESS_EXPONENT = 0.3;
export const HARDNESS_MIN = 0.4;
export const HARDNESS_MAX = 2.0;
/** Material resistance: ((yield / REF_YIELD) · (brinell / REF_BRINELL))^0.25, clamped. */
export const REF_YIELD_MPA = 800;
export const REF_BRINELL = 300;
export const RESISTANCE_MIN = 0.4;
export const RESISTANCE_MAX = 1.5;
/**
 * Elastomer pads (rubber soles). Scored by yield and hardness, rubber would be the weakest victim of all
 * and a kicker would shred its own ankles in a few kicks. A pad soaks the blow for the part behind it the
 * way it softens the blow for the target, so a cushioned victim takes HARDNESS_MIN of the base points.
 */
export const CUSHION_MATERIALS: readonly MaterialId[] = ['rubber'];

/** Hardness stand-ins for arena surfaces (the canvas and pads give, the chain link a little less). */
export const WORLD_SURFACES = {
  canvas: { brinell: 3, yieldMPa: 20, sparks: false },
  fence: { brinell: 40, yieldMPa: 250, sparks: false }, // vinyl-coated chain link
  post: { brinell: 8, yieldMPa: 20, sparks: false }, // padded
} as const;

// ---------------------------------------------------------------- detachment

/** Share of the hit's impulse that becomes the flying part's extra velocity (J / m · share). */
export const DETACH_KICK_SHARE = 0.35;
export const DETACH_MAX_KICK_MS = 10;
/** Mass left on the (now invisible) attached body so the joint chain stays well conditioned. */
export const DETACHED_BODY_MASS_KG = 0.05;

// ---------------------------------------------------------------- joint damage

/** Share of a part's impact damage points that goes into the joints of that part. */
export const JOINT_IMPACT_SHARE = 0.6;
/** Joints get sturdier with actuator size: hp = BASE + PER_NM · stall torque. */
export const JOINT_HP_BASE = 120;
export const JOINT_HP_PER_NM = 0.4;
/** A joint back-driven beyond this multiple of its stall torque is overloaded (gear damage). */
export const OVERLOAD_FACTOR = 2;
/** Overload is only tracked on an impact's load path, from first touch until this long after the window. */
export const OVERLOAD_ARM_TAIL_S = 0.03;
/** Health lost per overload = excess angular impulse / (stall torque · this many seconds). */
export const OVERLOAD_TOLERANCE_S = 2.5;
/** A violent overload (peak above this multiple of stall) may seize the gearbox. */
export const SEIZE_TORQUE_FACTOR = 8;
export const SEIZE_CHANCE = 0.006; // a seized joint is fight-changing; keep it rare
/** Damage points the gyro core absorbs (via hits on its housing part) before it fails completely. */
export const GYRO_HP_POINTS = 420;
/** Backlash at zero health, radians. */
export const MAX_SLOP_RAD = 0.12;

// ---------------------------------------------------------------- slow systems (hydraulics, heat, smoke, KO)

/** Slow systems run every N physics steps. */
export const SLOW_STRIDE = 10;
/** A hit worth this many damage points on a hydraulic part punctures its circuit. */
export const PUNCTURE_MIN_POINTS = 6;
/** Leak severity: base on puncture, plus this much per unit of lost hp. */
export const PUNCTURE_BASE_SEVERITY = 0.25;
export const PUNCTURE_SEVERITY_PER_HP = 1.2;
/** An open breach bleeds pressure even with fluid left. */
export const BREACH_PRESSURE_LOSS = 0.35;
/** Pump starves between these fluid fractions (pressure 0 below LOW, full above HIGH). */
export const FLUID_STARVE_LOW = 0.1;
export const FLUID_STARVE_HIGH = 0.55;

/** Smoke starts at this share of max motor temperature, and when part hp drops below SMOKE_HP. */
export const SMOKE_HEAT_START = 0.7;
export const SMOKE_HP = 0.4;
/** Smoke eases toward its target with this time constant, so it builds and clears. */
export const SMOKE_TAU_S = 0.6;

/** Knockout: down on the canvas for this long. */
export const KO_DOWN_S = 10;
/** Battery at or below this is empty. */
export const KO_BATTERY_EMPTY = 0.001;
