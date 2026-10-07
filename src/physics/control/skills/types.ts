// Skill contracts. A skill is a three-phase motion (windup → strike → recover) that writes the
// arms, torso, pelvis offsets and, for kicks, a borrowed leg, every control update.
import type { TargetZone } from '../../../core/protocol';
import type { Vec3 } from '../../../core/types';
import type { JointRuntime } from '../../sim-context';
import type { BalanceEngine } from '../balance/index';
import type { Gait } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import type { MocapSet } from '../mocap/library';
import type { MotionPlayer } from '../mocap/player';
import type { BodyCommand, JointMap } from '../posture';
import type { Sense } from '../sense';
import type { StanceParams } from '../stance';
import type { OpponentView } from './targets';

export type SkillId =
  | 'jab' | 'cross' | 'hook' | 'uppercut' | 'overhand' | 'rocket_punch'
  | 'front_kick' | 'low_kick' | 'head_kick'
  | 'guard' | 'clinch';

export type SkillKind = 'arm' | 'leg' | 'defense' | 'grapple';
export type SkillPhase = 'windup' | 'strike' | 'recover';

/** Posture offsets a skill layers on top of the fighting stance (all relative, radians / m). */
export interface SkillPose {
  pelvisYaw: number;
  pelvisPitch: number;
  pelvisRoll: number;
  pelvisDrop: number;
  waistYaw: number; // absolute waist targets
  waistPitch: number;
  weightShift: [number, number]; // COM target offset in the heading frame (forward, left), m
  holdFeet: boolean; // no planned footwork while this is set
}

export interface SkillEnv {
  s: Sense;
  geo: HumanoidGeometry;
  stance: StanceParams;
  opp: OpponentView;
  zone: TargetZone;
  aggression: number;
  heading: number;
  cmd: BodyCommand;
  pose: SkillPose;
  gait: Gait;
  /** World point → measured torso frame. */
  toTorso(p: Vec3): Vec3;
  /** Live joint state (motor, health, available torque) by design joint name. */
  joint(name: string): JointRuntime | undefined;
  /** Mocap playback (null: procedural moves only). */
  mocap: MocapSet | null;
  player: MotionPlayer | null;
  jm: JointMap;
  rng: () => number;
  /** The balance engine (CONTROL.balance = 'dcm'); null on the legacy path, whose strikes are as they were. */
  engine?: BalanceEngine | null;
}

export interface SkillRun {
  def: SkillDef;
  phase: SkillPhase;
  t: number; // time in phase
  /** Clip-timed skills: progress through the current phase (0..1) and through the whole move. */
  u?: number;
  progress?: number;
  /** The parts that land for this run (a mirrored clip strikes with the other side). */
  strikers?: string[];
  durations: Record<SkillPhase, number>;
  zone: TargetZone;
  aim: Vec3 | null; // world aim point, locked when the strike starts
  landed: boolean;
  landedSpeed: number;
  scratch: Record<string, unknown>;
}

export interface SkillDef {
  id: SkillId;
  kind: SkillKind;
  side: Side | null; // striking side ('l' is the lead in the orthodox stance)
  telegraph: number; // peak windup (0..1): how readable the strike is to the opponent
  durations: Record<SkillPhase, number>; // base seconds at aggression 0.5
  /** Joints that must work for this skill (design joint names). */
  requires(side: Side | null): string[];
  /** Parts whose contact with the opponent counts as the strike landing. */
  strikers: string[];
  /** COM-to-opponent-COM horizontal range (m) at which it lands, from the geometry. */
  range(geo: HumanoidGeometry): [number, number];
  /** Where in that range to stand (fraction) and how far in to walk before throwing. */
  approach?: { sweet: number; throwAt: number };
  defaultZone: TargetZone;
  /** Writes the command for phase progress u ∈ [0, 1]. */
  pose(env: SkillEnv, run: SkillRun, u: number): void;
  /** Kicks: may the windup end yet (leg granted)? Default true. */
  ready?(env: SkillEnv, run: SkillRun): boolean;
  /** Strike duration from the distance the striker must travel and the limb's top speed. */
  strikeTime?(env: SkillEnv, run: SkillRun): number;
  /** Called once when the run ends or is cancelled. */
  end?(env: SkillEnv, run: SkillRun): void;
  /** Mocap-driven: the clip's timeline sets the phases (see mocap/strikes.ts). */
  clip?: ClipSkill;
}

/** A skill played from the motion library: the clip drives the phases and writes the command. */
export interface ClipSkill {
  /** Pick and start a move for this run; false if none fits (the run is dropped). */
  begin(env: SkillEnv, run: SkillRun): boolean;
  /** Advance the clip by `dt` and write the command; `done` ends the run. */
  step(env: SkillEnv, run: SkillRun, dt: number): ClipStep;
}

export interface ClipStep {
  phase: SkillPhase;
  u: number; // progress through the phase
  progress: number; // through the whole move
  done: boolean;
}

export function neutralPose(stance: StanceParams): SkillPose {
  return {
    pelvisYaw: 0,
    pelvisPitch: 0,
    pelvisRoll: 0,
    pelvisDrop: 0,
    waistYaw: stance.waistYaw,
    waistPitch: stance.waistPitch,
    weightShift: [0, 0],
    holdFeet: false,
  };
}
