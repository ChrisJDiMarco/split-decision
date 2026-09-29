// Runtime motion library contracts: what the physics-side tracking controller consumes.
// Everything here is plain data (no three.js, no DOM) so it loads in the physics worker.
import type { Quat, Vec3 } from '../../core/types';

export type MoveLabel =
  | 'jab' | 'cross' | 'hook' | 'uppercut' | 'overhand'
  | 'front_kick' | 'low_kick' | 'head_kick' | 'side_kick'
  | 'block' | 'guard_idle'
  | 'shuffle_forward' | 'shuffle_back' | 'shuffle_left' | 'shuffle_right'
  | 'walk_forward' | 'walk_back'
  | 'getup_face_down' | 'getup_back' | 'getup_side'
  | 'victory'
  // Flashy and opportunistic moves (docs/design/fighter-intelligence.md): attempted, not guaranteed.
  | 'tornado_kick' | 'spinning_back_kick' | 'jump_kick' | 'jumping_knee' | 'superman_punch' | 'spinning_backfist'
  | 'feint_left' | 'feint_right' | 'pivot_left' | 'pivot_right' | 'switch_stance'
  | 'kipup_source';

export const MOVE_LABELS: readonly MoveLabel[] = [
  'jab', 'cross', 'hook', 'uppercut', 'overhand',
  'front_kick', 'low_kick', 'head_kick', 'side_kick',
  'block', 'guard_idle',
  'shuffle_forward', 'shuffle_back', 'shuffle_left', 'shuffle_right',
  'walk_forward', 'walk_back',
  'getup_face_down', 'getup_back', 'getup_side',
  'victory',
  'tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist',
  'feint_left', 'feint_right', 'pivot_left', 'pivot_right', 'switch_stance',
  'kipup_source',
];

/** Strikes that leave the ground or spin: attempted, may fail (they carry flight and spin data). */
export const FLASHY_LABELS: readonly MoveLabel[] = [
  'tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist',
];

/** Deceptive and angle-changing footwork. */
export const ANGLE_LABELS: readonly MoveLabel[] = ['feint_left', 'feint_right', 'pivot_left', 'pivot_right', 'switch_stance'];

export type LimbSide = 'l' | 'r';
export type StrikeHeight = 'low' | 'mid' | 'high';
export type MovePhase = 'windup' | 'strike' | 'recover';

/** Joint-level mirror map: q'[i] = sign[i] · q[perm[i]] (left ↔ right, southpaw ↔ orthodox). */
export interface MirrorMap {
  perm: Int16Array;
  sign: Float32Array;
}

export interface MoveSource {
  clip: string; // CMU clip id
  start: number; // first frame in the 60 Hz source track
  end: number; // exclusive
  mirrored: boolean; // the source was mirrored to make it orthodox
  scale: number; // leg-length ratio robot / actor (root and feet)
  lift: number; // m the actor was raised so a flat foot puts the robot's sole on the floor
  /** Source track world → move frame: rotate by −yaw after subtracting (x, y) (metres, scaled). */
  align: { yaw: number; x: number; y: number };
  /** Derived moves: the source track was edited before the retarget (human.ts spinTrack, then
   * leapTrack, then the mirror). Track frames; sides and angles are the unmirrored source's. */
  turn?: { from: number; to: number; angle: number; support: LimbSide };
  leap?: { from: number; to: number };
}

/**
 * The airborne part of a move: the longest run of frames where nothing touches the mat (no foot,
 * hand, knee, hips or chest contact). Seconds at 1×, like the phases.
 */
export interface MoveFlight {
  takeoff: number; // first frame with nothing on the mat
  land: number; // first frame something is back on the mat
  /** Highest pelvis rise over its height at take-off (m). */
  height: number;
}

export interface MoveQuality {
  fistErr: number; // mean fist position error after IK vs the scaled actor target, m
  footErr: number; // mean ankle position error, m
  limitRate: number; // fraction of joint-frames sitting on a range limit
}

/**
 * One move, stored orthodox (left side leads). Frames are 60 Hz. Root channels are the pelvis
 * pose relative to the move's start in the facing frame: x toward the opponent, y left, z up;
 * position (x, y) starts at 0, z is the absolute pelvis height above the floor.
 */
export interface Move {
  id: string;
  label: MoveLabel;
  side: LimbSide | null; // striking / blocking side (orthodox: 'l' is the lead)
  striker: string | null; // part id that should land ('fist_l', 'foot_r', ...)
  height: StrikeHeight | null;
  loop: boolean; // cyclic (guard_idle, walks): wraps cleanly
  fps: number;
  frames: number;
  duration: number; // seconds at 1×
  /** Phase boundaries in seconds: windup [0, strike), strike [strike, recover), recover [recover, duration]. */
  phases: { strike: number; recover: number };
  impact: number | null; // s: striker at peak speed (when it should connect)
  reach: number | null; // s: striker furthest out
  target: Vec3 | null; // striker position at `reach`, move frame (m): where the strike lands
  peakSpeed: number; // striker speed at impact at 1×, m/s
  /** Pelvis displacement start → end, move frame (m): how far footwork or a lunge carries you. */
  travel: Vec3;
  /** Largest time scale that keeps every joint under its motor's no-load speed (× margin). */
  maxSpeed: number;
  /** Starts with one foot leading and ends with the other (a kick that lands forward): after it
   * the fighter stands southpaw, so its next orthodox move plays mirrored. */
  switchesStance: boolean;
  /** Airborne phase (both feet and everything else off the mat), or null when always supported. */
  flight: MoveFlight | null;
  /** Pelvis heading change from the first to the last frame about the vertical (rad, + = turning
   * left / counter-clockwise seen from above). Spinning moves are stored turning clockwise (< 0),
   * the orthodox direction; mirrored they spin the other way. */
  spin: number;
  quality: MoveQuality;
  source: MoveSource;
  q: Float32Array; // frames × joints
  root: Float32Array; // frames × 7: x, y, z, qw, qx, qy, qz
  contacts: Uint8Array; // frames, CONTACT flags
  mirror: MirrorMap; // shared by the library
}

export interface MotionLibrary {
  design: string;
  fps: number;
  joints: readonly string[]; // channel order of Move.q and MotionSample.q
  jointSpeedLimit: Float32Array; // rad/s per joint (motor no-load speed)
  mirror: MirrorMap;
  moves: Move[];
  /** Moves filtered by label / side / height (all when no filter). */
  listMoves(filter?: MoveFilter): Move[];
  move(id: string): Move;
}

export interface MoveFilter {
  label?: MoveLabel | readonly MoveLabel[];
  side?: LimbSide;
  height?: StrikeHeight;
}

export interface SampleOptions {
  /** Time scale: 2 plays twice as fast (clamp to move.maxSpeed to stay within motor limits). */
  speed?: number;
  /** Swap sides (orthodox → southpaw). */
  mirror?: boolean;
  /** Wrap time for loops (default: move.loop). */
  loop?: boolean;
}

export interface MotionSample {
  time: number; // clip time sampled (s at 1×)
  phase: MovePhase;
  phaseU: number; // progress through the phase, 0..1
  q: Float64Array; // joint targets, library joint order (rad)
  qd: Float64Array; // joint velocities at the chosen speed (rad/s): servo feed-forward
  rootPos: Vec3; // pelvis, move frame (m)
  rootQuat: Quat; // pelvis attitude in the move frame [w, x, y, z]
  rootVel: Vec3; // m/s at the chosen speed
  contacts: number; // CONTACT flags
  done: boolean; // past the end of a non-looping move
}

// ---------------------------------------------------------------- serialized form

export const LIBRARY_FORMAT = 'split-decision/motions@1';

export interface MoveJson {
  id: string;
  label: MoveLabel;
  side: LimbSide | null;
  striker: string | null;
  height: StrikeHeight | null;
  loop: boolean;
  frames: number;
  phases: [number, number]; // frames: strike start, recover start
  impact: number | null; // frame
  reach: number | null; // frame
  target: Vec3 | null;
  peakSpeed: number;
  travel: Vec3;
  maxSpeed: number;
  switchesStance?: boolean; // absent in older libraries: false
  flight?: [number, number, number] | null; // frames: take-off, landing; pelvis rise (m). Absent: null
  spin?: number; // rad, absent: 0
  quality: MoveQuality;
  source: MoveSource;
  q: string; // base64 int16 LE, frames × joints, × QUANT.angle
  root: string; // base64 int16 LE, frames × 7: position × QUANT.pos, quaternion × QUANT.quat
  contacts: string; // base64 uint8, frames
}

export interface LibraryJson {
  format: typeof LIBRARY_FORMAT;
  design: string;
  generated: string;
  fps: number;
  joints: string[];
  jointSpeedLimit: number[];
  mirror: { perm: number[]; sign: number[] };
  moves: MoveJson[];
}

/** Quantization steps of the serialized channels. */
export const QUANT = { angle: 5e-4, pos: 5e-4, quat: 1 / 32767 } as const;
