// Stored form of a polished move (docs/design/move-polish.md §8): one JSON file per design and move,
// src/robots/motions/data/polished/<design>/<moveId>.json, orthodox, int16 blobs in base64 through
// codec.ts. Plain data and math: loads in Node, the browser and the physics worker.
import { base64ToBytes, bytesToBase64 } from '../codec';
import { QUANT } from '../types';

export const POLISH_FORMAT = 1;
/** Bump whenever PolishedPlayer's arithmetic changes: every stored polish becomes stale. */
export const PLAYER_VERSION = 'polished-player@2';

export type PolishStatus = 'polished' | 'infeasible' | 'failed' | 'stale';

/**
 * Feedback gains of the fixed, hand-structured law (move-polish.md §5.2). Every term acts only on the
 * part of an error beyond its dead band, so the nominal replay (errors inside the bands by
 * construction) gets exactly zero feedback and reproduces the optimiser's rollout.
 */
export interface FeedbackGains {
  /** Stance ankles: centre-of-pressure shift (m) per m of COM error, and per m of COM-velocity error / ω0
   *  (a DCM-style law); the shift becomes ankle torque m·g·share × (ẑ × Δp)·axis, sent as Δq = τ/kp. */
  ankleD: number;
  ankleV: number;
  /** Stance hips: correction (rad per rad) of the torso's tilt error. */
  hipTilt: number;
  /** Gyro: the same COP-style shift made by the gyro's couple (it moves the CMP), and torque per unit
   *  angular-momentum error against the simulated nominal (1/s, dead-banded); pitch and roll only, the
   *  GyroCore caps it. */
  gyroD: number;
  gyroV: number;
  gyroL: number;
  /** Per-joint clamp on the feedback, rad. */
  clamp: number;
}

export const ZERO_FEEDBACK: FeedbackGains = { ankleD: 0, ankleV: 0, hipTilt: 0, gyroD: 0, gyroV: 0, gyroL: 0, clamp: 0.15 };
export const DEFAULT_FEEDBACK: FeedbackGains = { ankleD: 1.5, ankleV: 1.5, hipTilt: 0.3, gyroD: 1, gyroV: 1, gyroL: 0, clamp: 0.15 };
/** Largest centre-of-pressure shift the ankle feedback asks for (m): beyond it the sole would roll. */
export const MAX_COP_SHIFT_M = 0.08;

/** Channels of the simulated nominal, per sample (move frame, orthodox). */
export const NOMINAL_CHANNELS = [
  'comX', 'comY', 'comZ', 'comVX', 'comVY', 'comVZ', 'LX', 'LY', 'LZ',
  'torsoW', 'torsoX', 'torsoY', 'torsoZ', 'pelvisX', 'pelvisY', 'pelvisZ', 'supX', 'supY',
] as const;
export const NOMINAL_STRIDE = NOMINAL_CHANNELS.length;
/** Quantization step of each nominal channel. */
const NOMINAL_STEP = [
  QUANT.pos, QUANT.pos, QUANT.pos, 1e-3, 1e-3, 1e-3, 0.01, 0.01, 0.01,
  QUANT.quat, QUANT.quat, QUANT.quat, QUANT.quat, QUANT.pos, QUANT.pos, QUANT.pos, QUANT.pos, QUANT.pos,
];
/** Nominal samples per wall second (every 4 physics steps, 2 control ticks). */
export const NOMINAL_HZ = 250;

/** Dead bands of the feedback errors. */
export interface DeadBands {
  com: number; // m
  comVel: number; // m/s
  L: number; // N·m·s
  tilt: number; // rad
}

export interface PolishEvent {
  side: 'l' | 'r';
  kind: 'lift' | 'land';
  t: number; // wall seconds after the move clock starts
  x: number;
  y: number;
}

export interface PolishJson {
  format: number;
  design: string;
  move: string;
  status: PolishStatus;
  reason?: string;
  hash: string;
  player: string;
  /** Spline knot spacing (clip seconds), segments (move + tail), tail length (clip s), settle before the clock starts (s). */
  knotS: number;
  segments: number;
  tailS: number;
  settleS: number;
  /** Clip rate (clip s per wall s) per 60 Hz clip frame, move + tail, × 1e-3. */
  rates: string;
  /** Δq control points: int16, (segments + 3) × joints (library order), × QUANT.angle. */
  dq: string;
  /** Gyro feed-forward, torso roll/pitch torque per knot (segments + 1) × 2, N·m × 0.01. */
  gyroFF?: string;
  fb: FeedbackGains;
  deadband: DeadBands;
  /** Simulated nominal: NOMINAL_HZ samples × NOMINAL_STRIDE channels, int16 (for the balance engine and the tube). */
  nominal: string;
  nominalSamples: number;
  /** The feedback's reference: per 60 Hz clip frame the clip's mass-aware COM (m) and torso up-axis,
   *  orthodox move frame, int16 × trackFrames × TRACK_STRIDE. */
  track: string;
  trackFrames: number;
  events: PolishEvent[];
  /** Mean clip rate over the move, wall duration of the move (s) and the human clip's duration. */
  rate: number;
  wallS: number;
  clipS: number;
  impact?: { tWall: number; speed: number; err: number } | null;
  envelope: { comSpeed: number; tilt: number; gyroReserve: number; battery: number; minHealth: number };
  validation: Record<string, unknown>;
  cpuS?: number;
}

export interface PolishedMove {
  json: PolishJson;
  design: string;
  moveId: string;
  status: PolishStatus;
  knotS: number;
  segments: number;
  tailS: number;
  settleS: number;
  rates: Float32Array;
  dq: Float32Array; // (segments + 3) × nj
  nj: number;
  gyroFF: Float32Array | null; // (segments + 1) × 2
  fb: FeedbackGains;
  deadband: DeadBands;
  nominal: Float32Array; // samples × NOMINAL_STRIDE
  nominalSamples: number;
  track: Float32Array; // trackFrames × TRACK_STRIDE
  trackFrames: number;
}

// ---------------------------------------------------------------- codec

function encodeInt16(values: ArrayLike<number>, step: number | readonly number[]): string {
  const out = new Uint8Array(values.length * 2);
  const steps = typeof step === 'number' ? null : step;
  for (let i = 0; i < values.length; i++) {
    const s = steps ? steps[i % steps.length] : (step as number);
    const v = Math.max(-32767, Math.min(32767, Math.round(values[i] / s)));
    out[i * 2] = v & 255;
    out[i * 2 + 1] = (v >> 8) & 255;
  }
  return bytesToBase64(out);
}

function decodeInt16(s: string, step: number | readonly number[]): Float32Array {
  const bytes = base64ToBytes(s);
  const out = new Float32Array(bytes.length >> 1);
  const steps = typeof step === 'number' ? null : step;
  for (let i = 0; i < out.length; i++) {
    let v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v * (steps ? steps[i % steps.length] : (step as number));
  }
  return out;
}

/** Reference track channels per clip frame: COM x, y, z, torso up-axis x, y, z (orthodox move frame). */
export const TRACK_STRIDE = 6;
const TRACK_STEP = [QUANT.pos, QUANT.pos, QUANT.pos, QUANT.quat, QUANT.quat, QUANT.quat];
export const encodeTrack = (t: ArrayLike<number>): string => encodeInt16(t, TRACK_STEP);
export const decodeTrack = (s: string): Float32Array => decodeInt16(s, TRACK_STEP);
export function quantizeTrack(values: Float64Array | Float32Array): void {
  for (let i = 0; i < values.length; i++) {
    const st = TRACK_STEP[i % TRACK_STRIDE];
    values[i] = Math.max(-32767, Math.min(32767, Math.round(values[i] / st))) * st;
  }
}

export const RATE_STEP = 1e-3;
export const GYRO_STEP = 0.01;

export const encodeRates = (r: ArrayLike<number>): string => encodeInt16(r, RATE_STEP);
export const decodeRates = (s: string): Float32Array => decodeInt16(s, RATE_STEP);
export const encodeDq = (d: ArrayLike<number>): string => encodeInt16(d, QUANT.angle);
export const decodeDq = (s: string): Float32Array => decodeInt16(s, QUANT.angle);
export const encodeGyro = (g: ArrayLike<number>): string => encodeInt16(g, GYRO_STEP);
export const decodeGyro = (s: string): Float32Array => decodeInt16(s, GYRO_STEP);
export const encodeNominal = (n: ArrayLike<number>): string => encodeInt16(n, NOMINAL_STEP);
export const decodeNominal = (s: string): Float32Array => decodeInt16(s, NOMINAL_STEP);

/** Quantize in place exactly as a store-and-load round trip would (the optimiser rolls out what will be stored). */
export function quantize(values: Float64Array | Float32Array, step: number): void {
  for (let i = 0; i < values.length; i++) values[i] = Math.max(-32767, Math.min(32767, Math.round(values[i] / step))) * step;
}
export function quantizeNominal(values: Float64Array | Float32Array): void {
  for (let i = 0; i < values.length; i++) {
    const s = NOMINAL_STEP[i % NOMINAL_STRIDE];
    values[i] = Math.max(-32767, Math.min(32767, Math.round(values[i] / s))) * s;
  }
}

export function decodePolish(json: PolishJson): PolishedMove {
  if (json.format !== POLISH_FORMAT) throw new Error(`polish ${json.design}/${json.move}: unsupported format ${json.format}`);
  const dq = decodeDq(json.dq);
  const nPts = json.segments + 3;
  return {
    json,
    design: json.design,
    moveId: json.move,
    status: json.status,
    knotS: json.knotS,
    segments: json.segments,
    tailS: json.tailS,
    settleS: json.settleS,
    rates: decodeRates(json.rates),
    dq,
    nj: dq.length / nPts,
    gyroFF: json.gyroFF ? decodeGyro(json.gyroFF) : null,
    fb: json.fb,
    deadband: json.deadband,
    nominal: decodeNominal(json.nominal),
    nominalSamples: json.nominalSamples,
    track: decodeTrack(json.track),
    trackFrames: json.trackFrames,
  };
}

// ---------------------------------------------------------------- compat hash

/** 64-bit FNV-1a over a string, as 16 hex digits (two 32-bit lanes; no BigInt needed). */
export function hashString(s: string, seed = ''): string {
  let h1 = 0x811c9dc5 ^ 0, h2 = 0x01000193 ^ 0x5bd1e995;
  const str = seed + s;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
