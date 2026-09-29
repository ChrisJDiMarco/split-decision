// Messages between the main thread and the physics worker.
import type { Corner, Loadout, MatchSetup, Vec3 } from './types';

// ---------------------------------------------------------------- brain → body

export type Tactic =
  | 'hold_range' | 'close_distance' | 'circle_left' | 'circle_right' | 'retreat'
  | 'jab' | 'cross' | 'hook' | 'uppercut' | 'overhand'
  | 'front_kick' | 'low_kick' | 'head_kick'
  | 'hammer_smash' | 'shield_bash' | 'rocket_punch' | 'jaw_crush' | 'lunge' | 'ram'
  | 'clinch' | 'guard' | 'feint' | 'sidestep_counter' | 'cage_pin'
  // Flashy and angle tactics (docs/design/fighter-intelligence.md). Until the control build lands,
  // the controller runs each as a safe fallback (tactics.ts, TODO(control-build)).
  | 'spinning_back_kick' | 'tornado_kick' | 'jump_kick' | 'jumping_knee' | 'superman_punch'
  | 'spinning_backfist' | 'switch_stance' | 'pivot_left' | 'pivot_right' | 'feint_left' | 'feint_right'
  | 'combo'; // run Intent.combo in order

/** Flashy moves: each has a fall/failure risk published in RobotTelemetry.moveRisk. */
export const FLASHY_MOVES = [
  'tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist', 'kip_up',
] as const;
export type FlashyMove = (typeof FLASHY_MOVES)[number];

/**
 * An opening one fighter sees on its opponent, computed in physics every frame. side_on: his
 * shoulders are 60-120° off square to you; turned_away: more than 120° (his back is to you).
 */
export type Opening =
  | 'off_balance' | 'turned_away' | 'missed_recovering' | 'stunned' | 'rising'
  | 'on_cage' | 'gyro_saturated' | 'weak_left_leg' | 'weak_right_leg' | 'low_guard' | 'overcommitted'
  | 'side_on';

export type Stance = 'orthodox' | 'southpaw';
export type GetupStyle = 'safe' | 'kip_up';

export type TargetZone = 'head' | 'torso' | 'left_arm' | 'right_arm' | 'left_leg' | 'right_leg' | 'weapon';

/** What the brain wants. The worker's skill layer turns it into motion. */
export interface Intent {
  tactic: Tactic;
  target: TargetZone;
  aggression: number; // 0 fully defensive .. 1 all-out
  counterIfLunge?: Tactic; // pre-armed reflex, fires without a round trip
  confidence: number; // Jev's confidence in the tactic, 0..1
  source: 'jev' | 'fallback' | 'player'; // 'player': a human at the keyboard (src/player)
  /** True when a code rule settled an obvious tick (down, far apart) without asking Jev. */
  settledLocally?: boolean;
  combo?: Tactic[]; // 2-4 strikes/feints run in order when tactic is 'combo', e.g. ['jab','cross','low_kick']
  getupStyle?: GetupStyle; // how to rise when down
  flourish?: boolean; // allowed to attempt a flashy variant if the opening is still there
  /**
   * Pre-armed opening reflexes, like counterIfLunge: the move to throw the instant one of these
   * openings appears (RobotTelemetry.openings) while this intent stands, without a brain round trip.
   * Short openings (missed_recovering, overcommitted: ~0.2 s) are gone before a decision could land.
   * Control contract: a new Intent re-arms it; poll this fighter's openings (openingsNow() in
   * src/physics/openings, cached per tick); the first time a listed opening is present while the
   * opponent is inside the move's range and the move is available
   * (canUse, moveRisk < 0.97, not mid-strike past the commit point) and no counterIfLunge is firing,
   * run the move once at max(aggression, 0.8) aimed at intent.target, then disarm until the next Intent.
   */
  onOpening?: Partial<Record<Opening, Tactic>>;
  /**
   * Setup → payoff structure of `combo` (docs/design/fighter-iq-control-contract.md). The first
   * `setup` steps fish for a reaction (a feint, a jab, a low kick, a stance switch); the rest is the
   * payoff at `payoffZone`. Absent on plain combos.
   */
  comboPlan?: ComboPlan;
  /**
   * Continuous footwork from a human player (src/player, WASD). Absent on brain intents.
   * Control contract (docs/design/player-mode-integration.md §Intent.move): fighter frame relative to
   * the opponent, each axis -1..1, |v| <= 1. forward +1 walks straight at him, -1 backs straight away;
   * strafe +1 steps to this fighter's own right (counter-clockwise around him seen from above, z up), -1 to its left.
   * {0,0} means plant and stand here (no auto-ranging). The vector is a velocity request scaled to the
   * design's safe walking speed; the balance engine owns foot placement and may refuse or slow any
   * step it cannot take (gyro saturated, bad leg, mid-strike). While it is present, footwork follows
   * it and `tactic` only picks the strike/defence; until control consumes it, the player maps it to
   * the footwork tactics (close_distance / retreat / circle_left / circle_right / hold_range).
   */
  move?: MoveVector;
  /** Which hand throws an arm strike that exists on both sides (hook): lead or rear. Advisory. */
  hand?: 'lead' | 'rear';
}

/** A footwork request in the fighter's opponent-locked frame (see Intent.move). */
export interface MoveVector {
  forward: number; // -1 back away .. +1 walk at him
  strafe: number; // -1 circle left .. +1 circle right
}

/** How a combination is built to fool him: the setup draws a reaction, the payoff hits what it exposes. */
export interface ComboPlan {
  setup: number; // the first `setup` steps of Intent.combo are the setup, the rest the payoff
  zones: TargetZone[]; // per step: where it lands, or for a 'feint' where it shows (head = high, torso = body, legs = low)
  payoffZone: TargetZone;
  fishing?: BiteReaction; // the reaction the setup is meant to draw
  tempo?: number[]; // seconds to hold before each step: a rhythm break is a pause, then the burst
  /** Set while the brain sequences the combo step by step (control not yet running comboPlan itself). */
  step?: number;
}

// ---------------------------------------------------------------- body → world

export type SimEvent =
  | {
      kind: 'impact';
      pos: Vec3;
      normal: Vec3;
      impulseNs: number;
      speed: number; // closing speed at the contact, m/s
      energyJ: number;
      striker: Corner | null; // null = floor / cage
      victim: Corner | null;
      part: string | null; // victim part id
      metal: boolean; // both sides metal: sparks + clang
    }
  | { kind: 'detach'; corner: Corner; part: string; debrisBody: number; pos: Vec3; vel: Vec3 }
  | { kind: 'joint'; corner: Corner; joint: string; health: number; state: JointState }
  | { kind: 'fall'; corner: Corner }
  | { kind: 'getup'; corner: Corner }
  | { kind: 'ko'; corner: Corner; reason: 'head' | 'down' | 'power' | 'disabled' }
  | { kind: 'cage'; corner: Corner; pos: Vec3; speed: number };

/**
 * Referee break events (src/physics/systems/referee.ts). 'break': someone went down, the standing
 * fighter is sent to a neutral spot and throws nothing; again with both corners if it becomes a
 * double knockdown. 'fight': everyone has been fully up for the grace period, fighting resumes.
 * A KO during a break ends it without a 'fight' (the 'ko' event says it all).
 * Not yet part of SimEvent: src/ui/ticker-feed.ts fromEvent() switches over every SimEvent kind with
 * no default, so a new kind fails the type check there. Until it gets a default branch the referee
 * logs these in SimContext.referee.log and the frame carries RobotTelemetry.referee.
 */
export type RefereeEvent =
  | { kind: 'break'; down: Corner[] }
  | { kind: 'fight'; breakS: number };

export type JointState = 'ok' | 'degraded' | 'limp' | 'seized';

/**
 * Where the head is looking (src/physics/systems/gaze.ts). track: the opponent's head; threat: an
 * incoming strike; aim: the target, just before throwing; down: the canvas where a hand plants;
 * scan: no one in reach, sweeping.
 */
export type GazeMode = 'track' | 'threat' | 'aim' | 'down' | 'scan';

/**
 * The referee's view of one fighter (src/physics/systems/referee.ts). role during a break: 'down' on
 * the canvas or still rising; 'neutral' sent to (or standing at) a neutral spot, no blows; 'hold' back
 * up, waiting for FIGHT. The body obeys the referee over the intent; RobotTelemetry.intent still shows
 * what the brain (or player) asked for.
 */
export interface RefereeTelemetry {
  break: boolean;
  role?: 'down' | 'neutral' | 'hold';
  neutral?: Vec3; // role 'neutral': the spot he was sent to (world, z = 0)
  breakS?: number; // seconds since the break started
}

export interface Gaze {
  point: Vec3; // world point the head is fixated on
  mode: GazeMode;
  /** 0..1 lock-on: flares when committing to a big shot, a flourish or an opening reflex, then decays. */
  lock?: number;
}

export interface PartTelemetry {
  id: string;
  hp: number; // 0..1
  smoke: number; // 0..1 emission rate
  heat: number; // 0..1 of max temp
  attached: boolean;
  leak: number; // litres per second of hydraulic fluid escaping here
  ventWorld?: Vec3; // world-space vent point for smoke / leaks
  ventVel?: Vec3;
}

export interface JointTelemetry {
  name: string;
  health: number; // 0..1
  state: JointState;
  tempC: number;
  torqueFrac: number; // |torque| / available torque
}

export interface RobotTelemetry {
  corner: Corner;
  upright: number; // 1 standing tall .. 0 flat on the canvas
  balance: number; // 0..1, how close the COM is to leaving the support area
  down: boolean;
  comWorld: Vec3;
  heading: number; // yaw, radians
  velocity: Vec3;
  battery: number; // 0..1
  gyroHealth: number; // 0..1, 0 if no gyro
  gyroSaturation: number; // 0..1
  hydraulicPressure: Record<string, number>; // circuit id → 0..1
  skill: string; // what the body is executing right now
  skillPhase: number; // 0..1 progress through the skill
  windup: number; // 0..1 how far into a telegraphed strike (for the opponent's read)
  parts: PartTelemetry[];
  joints: JointTelemetry[];
  damageTotal: number; // 0..1 overall
  intent: Intent | null;
  // Fighter intelligence (src/physics/openings). Optional so hand-built telemetry (fixtures, the
  // showroom puppet, the dev fake fight) stays valid; the physics worker always fills them.
  openings?: Opening[]; // what this fighter sees on its opponent right now
  moveRisk?: Record<string, number>; // 0..1 fall/failure risk per flashy move (FlashyMove), from body state; balance term held at the last planted moment
  stance?: Stance; // from the lead foot, read with both feet planted and held >= 0.4 s (no flip per step)
  facingOffDeg?: number; // signed angle of the shoulders off square to the opponent (CCW positive)
  gaze?: Gaze; // head and optics (src/physics/systems/gaze.ts)
  /** Dexterous hands only: grip command per hand, 0 open .. 1 fist (src/physics/systems/hands.ts). */
  grip?: { l: number; r: number };
  // Fighter IQ (src/physics/openings): what this fighter has worked out about its opponent.
  weakSpots?: WeakSpot[]; // his best targets right now, ranked (at most 3)
  reads?: FeintRead[]; // the last few feints this fighter threw and how he answered them (newest last)
  habits?: Habit[]; // his habits this fight, strongest first
  referee?: RefereeTelemetry; // referee break state (src/physics/systems/referee.ts)
}

// ---------------------------------------------------------------- fighter IQ (src/physics/openings)

/** Why a zone is worth hitting. `value` is 0..1 unless noted; `part` names a joint, part or material. */
export type WeakReasonKind =
  | 'joint_failing' // a drive in the zone is worn or failing (part: joint, value: health)
  | 'joint_slop' // worn gear lash in the zone (value: fraction of the max backlash)
  | 'joint_hot' // a motor in the zone near its temperature limit (value: fraction of max temp)
  | 'armor_cracked' // the zone's worst shell (part, value: hp)
  | 'soft_armor' // design: thin or soft shells (part: material, value: mm)
  | 'glass_jaw' // design: his head-break impulse over your clean-shot power (value: ratio, below 1 pops)
  | 'narrow_base' // design: tall on a narrow base (value: COM height / hip span)
  | 'light_frame' // design: much lighter than you (value: your mass / his)
  | 'slow_legs' // design: slow hip drives (value: rad/s)
  | 'gyro_drained' // his gyro is loaded or damaged (value: momentum budget left)
  | 'guard_open' // his guard leaves this zone open right now (side: which side of the head)
  | 'lead_leg' // his lead leg: the one in front, carrying the weight
  | 'keeps_landing'; // your shots keep landing here (value: count)

export interface WeakReason { kind: WeakReasonKind; part?: string; value?: number; side?: 'left' | 'right' }

export interface WeakSpot {
  zone: TargetZone;
  score: number; // 0..1
  reasons: WeakReason[]; // strongest first
  side?: 'left' | 'right'; // head only: the open side of his head
}

/** How he answered a feint: raised or dropped his guard, stepped away, flinched, or threw back. */
export type BiteReaction = 'covered' | 'retreated' | 'flinched' | 'countered';
export type FeintLevel = 'high' | 'body' | 'low';

/** One feint (a strike windup pulled before it commits) and his answer, read in physics. */
export interface FeintRead {
  seq: number; // increasing per fighter
  time: number; // sim s the read resolved
  level: FeintLevel; // where it showed
  limb: 'arm' | 'leg';
  skill: string; // the control skill whose windup was shown ('jab', 'low_kick', ...)
  deliberate: boolean; // the intent asked for a feint, or no mind drives the robot (a windup pulled for another reason is no feint and gets no read)
  bit: boolean;
  reactions: BiteReaction[];
}

/**
 * A habit of his, counted this fight: bites on feints at a level, circles one way when pressured,
 * backs straight up, drops a hand after a strike, throws back at feints.
 */
export interface Habit {
  kind: 'bites' | 'circles' | 'retreats_straight' | 'drops_hand' | 'counters';
  level?: FeintLevel; // bites
  side?: 'left' | 'right'; // circles, drops_hand (his left / right)
  after?: string; // drops_hand: the strike (control skill id) he throws before it
  n: number;
  of: number;
}

/** Static layout the renderer needs to build meshes and read poses. */
export interface WorldMeta {
  nbody: number;
  timestep: number;
  robots: Array<{
    corner: Corner;
    design: string;
    prefix: string;
    parts: Array<{ id: string; body: number; debrisBody: number | null }>;
    loadout?: Loadout; // the renderer builds the same loaded design (applyLoadout)
  }>;
  props: Array<{ name: string; body: number }>; // loose debris bolts, plates
}

export type MainToWorker =
  | { type: 'init'; setup: MatchSetup }
  | { type: 'intent'; corner: Corner; intent: Intent; issuedAtTick: number }
  | { type: 'release' } // drop the robots from the gantry: fight starts
  | { type: 'pause'; paused: boolean }
  | { type: 'timescale'; scale: number } // 1 = real time, 0.1 = 10x slow motion
  | { type: 'reset' };

export type WorkerToMain =
  | { type: 'ready'; meta: WorldMeta }
  | {
      type: 'frame';
      tick: number;
      time: number;
      poses: Float32Array; // nbody * 7: x y z qw qx qy qz
      events: SimEvent[];
      telemetry: [RobotTelemetry, RobotTelemetry];
      stepMs: number; // average wall time per physics step, for the perf HUD
      blowups?: number; // physics divergences rolled back to the last keyframe
    }
  | { type: 'error'; message: string };
