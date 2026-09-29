// Runtime state shared by the physics systems inside the worker.
import type { Intent, JointState, RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, FighterSetup, MotorSpec, RobotDesign } from '../core/types';
import type { CompiledRobot } from '../robots/compile-mjcf';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Mujoco = any; // the @mujoco/mujoco module (typings are loose `any` views)
export type MjModel = any;
export type MjData = any;

export interface JointRuntime {
  name: string;
  part: string;
  qadr: number; // index into qpos
  dadr: number; // index into qvel
  act: number; // actuator index
  motor: MotorSpec;
  kp: number;
  kd: number;
  hydraulicCircuit?: string;
  health: number; // 1 healthy .. 0 destroyed
  state: JointState;
  tempC: number;
  availableTorque: number; // after speed, heat, damage, pressure
  slop: number; // radians of backlash added by damage
  seizedAt?: number; // joint angle the gearbox locked at (state 'seized')
  slopOffset?: number; // current backlash wander, radians
  slopGoal?: number; // where the wander is drifting to
  slopTimer?: number; // seconds until a new wander goal
}

export interface PartRuntime {
  id: string;
  body: number;
  debrisBody: number | null;
  geoms: number[];
  debrisGeoms: number[];
  hp: number; // 0..1
  damage: number; // accumulated damage points
  attached: boolean;
  smoke: number; // 0..1
  heat: number; // 0..1
  leak: number; // L/s
}

export interface RobotRuntime {
  corner: Corner;
  setup: FighterSetup;
  design: RobotDesign;
  compiled: CompiledRobot;
  rootBody: number;
  rootQadr: number; // free joint qpos address (x y z qw qx qy qz)
  rootDadr: number;
  joints: JointRuntime[];
  jointIndex: Map<string, number>;
  parts: Map<string, PartRuntime>;
  /** Joint position targets, written by the controller, read by the servos. */
  targets: Float64Array;
  /** Optional feed-forward torques (N·m) added on top of the servo, e.g. gravity comp. */
  feedforward: Float64Array;
  intent: Intent | null;
  pendingIntents: Array<{ applyAtTick: number; intent: Intent }>;
  hydraulics: Map<string, { pressure: number; fluidL: number }>;
  gyro: { health: number; saturation: number } | null;
  battery: number; // 0..1
  down: boolean;
  koReason: string | null;
  skill: string;
  skillPhase: number;
  windup: number;
  /** Free-form scratch space for systems (controller state, damage timers...). */
  mem: Record<string, unknown>;
}

export interface SimContext {
  mj: Mujoco;
  model: MjModel;
  data: MjData;
  robots: [RobotRuntime, RobotRuntime];
  tick: number;
  time: number;
  dt: number;
  released: boolean;
  events: SimEvent[]; // drained every frame
  rng: () => number; // seeded, deterministic
  eqActive: number[]; // mirror of eq_active (the binding cannot read it directly)
  setEqActive: (index: number, on: boolean) => void;
  eqIndex: (name: string) => number;
}

/** A physics-side module. `pre` runs before mj_step, `post` after. Both run every step. */
export interface SimSystem {
  name: string;
  init?(ctx: SimContext): void;
  pre?(ctx: SimContext): void;
  post?(ctx: SimContext): void;
  telemetry?(ctx: SimContext, robot: RobotRuntime, out: RobotTelemetry): void;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
