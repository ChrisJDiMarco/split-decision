// Small vector / rotation helpers for the controller. Plain number tuples, row-major 3×3
// matrices (MuJoCo's xmat layout: world = R · local). No three.js inside the worker.
import type { Vec3 } from '../../core/types';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Minimum-jerk position profile on [0, 1]: zero velocity and acceleration at both ends. */
export function minJerk(t: number): number {
  const s = clamp(t, 0, 1);
  return s * s * s * (10 + s * (-15 + 6 * s));
}

/** Derivative of minJerk with respect to its argument. */
export function minJerkRate(t: number): number {
  const s = clamp(t, 0, 1);
  return 30 * s * s * (1 - s) * (1 - s);
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

// ---------------------------------------------------------------- vectors

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function normalize(a: Vec3, fallback: Vec3 = [1, 0, 0]): Vec3 {
  const n = norm(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : fallback;
}

export const dist2d = (a: Vec3 | [number, number], b: Vec3 | [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------- matrices

export const IDENTITY: Readonly<Mat3> = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMV(m: Readonly<Mat3>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rᵀ·v: world vector into the local frame of R. */
export function mulMtV(m: Readonly<Mat3>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function mulMM(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  const out = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

/** aᵀ·b */
export function mulMtM(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  const out = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i] * b[j] + a[3 + i] * b[3 + j] + a[6 + i] * b[6 + j];
    }
  }
  return out;
}

export function rotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Body attitude from yaw (about world z), then pitch (about the yawed y), then roll (about the pitched x). */
export function yawPitchRoll(yaw: number, pitch: number, roll: number): Mat3 {
  return mulMM(mulMM(rotZ(yaw), rotY(pitch)), rotX(roll));
}

/** Rotation whose columns are the given (orthonormal) axes. */
export function fromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function readMat(arr: ArrayLike<number>, index: number): Mat3 {
  const o = index * 9;
  return [arr[o], arr[o + 1], arr[o + 2], arr[o + 3], arr[o + 4], arr[o + 5], arr[o + 6], arr[o + 7], arr[o + 8]];
}

export function readVec(arr: ArrayLike<number>, index: number): Vec3 {
  const o = index * 3;
  return [arr[o], arr[o + 1], arr[o + 2]];
}

/** Heading (yaw) of a body frame: direction of its local x axis projected on the ground. */
export function yawOf(m: Readonly<Mat3>): number {
  return Math.atan2(m[3], m[0]);
}

/** Axis-angle error that rotates frame `cur` onto frame `des` (world frame, small-angle accurate). */
export function rotationError(cur: Readonly<Mat3>, des: Readonly<Mat3>): Vec3 {
  // 0.5 · Σ cur_i × des_i over the three columns is the standard attitude error.
  const e: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a: Vec3 = [cur[c], cur[3 + c], cur[6 + c]];
    const b: Vec3 = [des[c], des[3 + c], des[6 + c]];
    const x = cross(a, b);
    e[0] += 0.5 * x[0];
    e[1] += 0.5 * x[1];
    e[2] += 0.5 * x[2];
  }
  return e;
}

/** Rotate a 2D vector (x, y) by angle a. */
export function rot2(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
}

/** Rotation vector (axis × angle, rad) of R: the log map. */
export function logMat(R: Readonly<Mat3>): Vec3 {
  const c = clamp((R[0] + R[4] + R[8] - 1) / 2, -1, 1);
  const a = Math.acos(c);
  if (a < 1e-7) return [0, 0, 0];
  if (Math.PI - a < 1e-4) {
    // Half turn: the axis is the dominant column of (R + I) / 2.
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    if (x >= y && x >= z) return [x * a, (R[1] >= 0 ? y : -y) * a, (R[2] >= 0 ? z : -z) * a];
    if (y >= z) return [(R[1] >= 0 ? x : -x) * a, y * a, (R[5] >= 0 ? z : -z) * a];
    return [(R[2] >= 0 ? x : -x) * a, (R[5] >= 0 ? y : -y) * a, z * a];
  }
  const k = a / (2 * Math.sin(a));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Rotation from a rotation vector (Rodrigues): the exp map. */
export function expMat(v: Vec3): Mat3 {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return [...IDENTITY] as Mat3;
  const x = v[0] / a, y = v[1] / a, z = v[2] / a;
  const s = Math.sin(a), c = 1 - Math.cos(a);
  return [
    1 - c * (y * y + z * z), -s * z + c * x * y, s * y + c * x * z,
    s * z + c * x * y, 1 - c * (x * x + z * z), -s * x + c * y * z,
    -s * y + c * x * z, s * x + c * y * z, 1 - c * (x * x + y * y),
  ];
}

/** Shortest-path interpolation between two orientations (t = 0 → a, 1 → b). */
export function slerpMat(a: Readonly<Mat3>, b: Readonly<Mat3>, t: number): Mat3 {
  return mulMM(a, expMat(scale(logMat(mulMtM(a, b)), t)));
}
