// Messages between the main thread and the physics worker.
import type { Corner, MatchSetup, Vec3 } from './types';

// ---------------------------------------------------------------- brain → body

export type Tactic =
  | 'hold_range' | 'close_distance' | 'circle_left' | 'circle_right' | 'retreat'
  | 'jab' | 'cross' | 'hook' | 'uppercut' | 'overhand'
  | 'front_kick' | 'low_kick' | 'head_kick'
  | 'hammer_smash' | 'shield_bash' | 'rocket_punch' | 'jaw_crush' | 'lunge' | 'ram'
  | 'clinch' | 'guard' | 'feint' | 'sidestep_counter' | 'cage_pin';

export type TargetZone = 'head' | 'torso' | 'left_arm' | 'right_arm' | 'left_leg' | 'right_leg' | 'weapon';

/** What the brain wants. The worker's skill layer turns it into motion. */
export interface Intent {
  tactic: Tactic;
  target: TargetZone;
  aggression: number; // 0 fully defensive .. 1 all-out
  counterIfLunge?: Tactic; // pre-armed reflex, fires without a round trip
  confidence: number; // Jev's confidence in the tactic, 0..1
  source: 'jev' | 'fallback';
  /** True when a code rule settled an obvious tick (down, far apart) without asking Jev. */
  settledLocally?: boolean;
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

export type JointState = 'ok' | 'degraded' | 'limp' | 'seized';

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
