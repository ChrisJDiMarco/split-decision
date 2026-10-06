// Tuning constants for the damage model. Units are SI unless the name says otherwise.
// docs/design/strike-power.md §3.2 and §4 explain the model. Thresholds that the measured strike
// distributions must set (stage 5b, after the balance build's P3 makes strikes fast) live in
// DAMAGE_TUNING below, in one place, so tools/strike-bench.ts can A/B them (--tune DAMAGE_TUNING.key=v).
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
/**
 * Presentation energy of an impact event (energyJ): ½·m_eff·v² with m_eff = the struck body plus this
 * share of its parent. Kept so hit-feel, camera and audio scales stay calibrated; the damage model
 * itself uses the measured absorbed work (workJ).
 */
export const CHAIN_MASS_SHARE = 0.5;

// ---------------------------------------------------------------- part damage

/**
 * Elastomer pads and gloves: they soak the blow themselves (their own compliance takes most of a hit's
 * work in the split by stiffness, src/physics/damage/shell.ts) and never dent.
 */
export const CUSHION_MATERIALS: readonly MaterialId[] = ['rubber', 'glove'];

/** Hardness stand-ins for arena surfaces (the canvas and pads give, the chain link a little less). */
export const WORLD_SURFACES = {
  canvas: { brinell: 3, yieldMPa: 20, sparks: false },
  fence: { brinell: 40, yieldMPa: 250, sparks: false }, // vinyl-coated chain link
  post: { brinell: 8, yieldMPa: 20, sparks: false }, // padded
} as const;

// ---------------------------------------------------------------- detachment

/**
 * Only a strike from the other robot can pop a part off in one blow. Falls into the canvas, the cage
 * and flying debris still dent it (at this share of the damage points) and count toward the
 * accumulated-damage break, but a stumble can't decapitate anyone.
 */
export const NON_STRIKE_DAMAGE_SCALE = 0.35;
/**
 * A one-blow knockoff also needs a clean, committed shot: a fist, glove, foot or shin landing at
 * least this fast. Pushes, clinch bumps and slow shots only add accumulated damage.
 */
export const CLEAN_HIT_MIN_SPEED = 4.5;

/** Share of the hit's impulse that becomes the flying part's extra velocity (J / m · share). */
export const DETACH_KICK_SHARE = 0.35;
export const DETACH_MAX_KICK_MS = 10;
/** Mass left on the (now invisible) attached body so the joint chain stays well conditioned. */
export const DETACHED_BODY_MASS_KG = 0.05;

// ---------------------------------------------------------------- joint damage

/** Overload is only tracked on an impact's load path, from first touch until this long after the window. */
export const OVERLOAD_ARM_TAIL_S = 0.03;
/** Damage points the gyro core absorbs (via hits on its housing part) before it fails completely. */
export const GYRO_HP_POINTS = 420;
/** Backlash at zero health, radians. */
export const MAX_SLOP_RAD = 0.12;

// ---------------------------------------------------------------- slow systems (hydraulics, heat, smoke, KO)

/** Slow systems run every N physics steps. */
export const SLOW_STRIDE = 10;
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

/**
 * Knockout: down on the canvas for this long. Real humanoid leagues give a fallen robot 20 s to
 * rise unassisted (EngineAI's URKL, 2026; docs/research/07-china-robot-fights.md).
 */
export const KO_DOWN_S = 20;
/** Battery at or below this is empty. */
export const KO_BATTERY_EMPTY = 0.001;

// ---------------------------------------------------------------- PROVISIONAL thresholds (calibrate after P3)

/**
 * Every threshold the measured strike distributions must set. PROVISIONAL: today's strikes land at
 * 2-4.5 m/s; the balance build's P3 will make them 2-3× faster, so these were chosen to keep
 * blocks, jabs and footfalls at ~0 and leave room above, not tuned to fire on today's punches.
 * Recalibrate from tools/strike-bench.ts and tools/fight-metrics.ts (stage 5b) against the damage
 * targets in §5.2 (decision D4). Never lower them to fake breaks (honesty rule 7).
 * Mutable on purpose: the bench overrides entries with --tune DAMAGE_TUNING.key=value.
 */
export const DAMAGE_TUNING = {
  // ---- impact accounting (§3.2): one strike = one episode
  /** A strike is measured over this window from its first touch (all contact pairs between the two robots). */
  strikeWindowS: IMPACT_WINDOW_S,
  /** Contact between the same two robots this soon after a strike's window is a push, not a new strike... */
  pushTailS: 0.35,
  /** ...unless a fresh pair arrives at least this fast. */
  newStrikeSpeed: 1.5,

  // ---- shells (§4.1-4.2; src/physics/damage/shell.ts)
  /** Unsupported panel span of a shell zone (clamped circular plate, diameter). Assumed. */
  panelSpanM: 0.12,
  /** Contact stiffness of solid strikers and cushions (N/m), for the work split. Assumed. */
  solidStiffness: 2e8, // a steel knuckle plate or fist block
  gloveStiffness: 7.5e4, // a boxing glove: 18-29 ms contacts (Nakano et al., ISBS 2009) at ~3 kg
  soleStiffness: 1e6, // a rubber foot pad
  canvasStiffness: 1.5e5, // mat over foam over the deck
  fenceStiffness: 5e4,
  postStiffness: 3e4,
  /** Robot-world contacts spread the load over a patch: collapse load × this (elastic limit × its square). */
  worldSpread: 4,
  /** Visible share of a plastic dent that stays (the rest springs back), by failure mode. */
  springback: { dent: 0, whiten: 0.4, gouge: 0.25, crack: 0, cushion: 1 },
  /** Polycarbonate cracks as well as dents once the dent is this many shell thicknesses deep. */
  whitenCrackDepthH: 4,
  /** Part damage points per joule of plastic work, and the multiplier for a crack (carbon delaminates). */
  pointsPerPlasticJ: 1,
  crackPointsFactor: 3,
  /** A cracked zone keeps this share of its collapse load (and its square of elastic energy) per crack. */
  crackWeakening: 0.5,
  crackWeakeningFloor: 0.2,
  /** A hydraulic part punctures when it takes this much of a hit's work. */
  punctureWorkJ: 25,
  /** A contact force above this in one step is the solver blowing up, not a hit: it is ignored. */
  maxContactForceN: 2e5,
  /**
   * A joint load past this many times its rating in one step is the solver crushing interpenetrating
   * bodies (an arm sandwiched in a clinch), not a load a part could carry: the sample is skipped.
   * The hardest kick in the audit (21 kN) puts ~3-4× the static rating through a knee.
   */
  maxLoadRatio: 20,
  /**
   * Shell yield and housing hits read the contact force filtered over this many steps (as the joint
   * loads are): the solver's one-step spike at first touch is the stiff contact model, not the load
   * a shell or a drive cover feels.
   */
  forceFilterSteps: 3,

  // ---- joint loads (§4.3; src/physics/damage/joint-loads.ts): multiples of the rating
  /** Loads are filtered over this long (gear mesh and structure compliance smooth 1 ms solver spikes). */
  loadFilterS: 0.003,
  gearOnset: 1, // gear wear starts at the gear's shock rating...
  gearBreak: 1.6, // ...it fails here (planetary jams / QDD sheds a tooth / cylinder seal blows)...
  gearStrip: 2.6, // ...and strips (output free) here
  /**
   * End stop: a lug on the same housing that carries the output bearing, so it is rated like that
   * housing (the bearing's static moment) and never below stopRatingStall × the drive's own peak
   * (a drive must not be able to break its own stop). Assumed.
   */
  stopOnset: 1,
  stopBreak: 1.8, // the stop gives way: hyperextension
  stopRatingStall: 2,
  /**
   * Bearing ratings: the catalog's tilting moment and radial / axial loads are permissible operating
   * values; the static capacity (permanent deformation of the races) is about this many times higher
   * (static safety factor ~1 against the ~3 of rated-life selection). Assumed.
   */
  bearingStaticFactor: 3,
  /**
   * A joint that carries a heavy subtree (the waist under the trunk) runs its side loads through a
   * structural bearing pair, not only the module's own bearing: its permissible moment is at least
   * what this many g of its own subtree at its centre of mass demand (a body's own landing and
   * whipping loads). Only the waist and hips come out above their modules. Assumed.
   */
  structuralG: 6,
  bearingOnset: 1.5, // × static capacity: brinelling, the joint gets rough
  bearingBreak: 2.5, // the shaft bends (binds)
  /** Health lost by a load just under its break, linear from the onset. */
  wearAtBreak: 0.25,
  /** Health lost by each failure. */
  failLoss: { seize: 0.4, strip: 1, slip: 0.25, bend: 0.25, hyperextension: 0.35, seal: 0.3, fault: 0.02 },
  /** A QDD that sheds a tooth slips above this share of its peak torque; a second one cuts it by slipCapCut. */
  slipCapFraction: 0.45,
  slipCapCut: 0.6,
  slipStripBelow: 0.12, // a cap below this share of peak means the gear is stripped (limp)
  /** Permanent bend per unit of bearing overload past break, its cap, and the bind it brings. */
  bendDegPerUnit: 5,
  maxBendDeg: 15,
  bendRampS: 0.08, // the body bends over this long (no teleporting limbs)
  bindFrictionStall: 0.06, // frictionloss added per unit severity, × stall
  bindRangeDeg: 8, // range lost per unit severity (each side), toward where the joint is
  hyperextensionDeg: 10, // the stop gives this far per unit severity (cap 1.5)
  /** Striker arming: its own load path counts when it lands off-axis or into its own stop. */
  strikerOffAxisDeg: 65,
  stopMarginDeg: 5,
  /**
   * Housing hits: a striking surface (fist, foot, shin; or a thrown prop) landing within the drive's
   * housing reach of its anchor with this much (filtered) force faults it.
   */
  housingForceN: 6000,
  housingMarginM: 0.01,
  faultMinS: 0.25,
  faultMaxS: 0.9,
  faultSlopRad: 0.01, // encoder damage: extra wander per fault, capped at MAX_SLOP_RAD
  // ---- defaults for a motor without catalog drive-train fields (labelled assumptions)
  defaultGearShock: 1.9,
  defaultRatio: 9,
  defaultRotorKgM2: 1e-4,
};

export type DamageTuning = typeof DAMAGE_TUNING;
