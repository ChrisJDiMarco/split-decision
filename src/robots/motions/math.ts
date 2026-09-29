// Small vector / rotation helpers for the motion pipeline. Plain tuples so the same code runs in
// Node (offline tools), the physics worker and the browser. Matrices are row-major 3×3 like
// MuJoCo's xmat (world = R · local); quaternions are MuJoCo order [w, x, y, z].
import type { Quat, Vec3 } from '../../core/types';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const mixV = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function normalize(a: Vec3, fallback: Vec3 = [1, 0, 0]): Vec3 {
  const n = norm(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : fallback;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

// ---------------------------------------------------------------- matrices

export const identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMV(m: Readonly<Mat3>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rᵀ·v: a world vector in the local frame of R. */
export function mulMtV(m: Readonly<Mat3>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function mulMM(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/** aᵀ·b */
export function mulMtM(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  return [
    a[0] * b[0] + a[3] * b[3] + a[6] * b[6], a[0] * b[1] + a[3] * b[4] + a[6] * b[7], a[0] * b[2] + a[3] * b[5] + a[6] * b[8],
    a[1] * b[0] + a[4] * b[3] + a[7] * b[6], a[1] * b[1] + a[4] * b[4] + a[7] * b[7], a[1] * b[2] + a[4] * b[5] + a[7] * b[8],
    a[2] * b[0] + a[5] * b[3] + a[8] * b[6], a[2] * b[1] + a[5] * b[4] + a[8] * b[7], a[2] * b[2] + a[5] * b[5] + a[8] * b[8],
  ];
}

export function transpose(m: Readonly<Mat3>): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
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

/** Rotation about a unit axis (Rodrigues). */
export function axisAngle(axis: Vec3, a: number): Mat3 {
  const [x, y, z] = axis;
  const s = Math.sin(a), c = 1 - Math.cos(a);
  return [
    1 - c * (y * y + z * z), -s * z + c * x * y, s * y + c * x * z,
    s * z + c * x * y, 1 - c * (x * x + z * z), -s * x + c * y * z,
    -s * y + c * x * z, s * x + c * y * z, 1 - c * (x * x + y * y),
  ];
}

/** Rotation whose columns are the given (orthonormal) axes. */
export function fromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export const col = (m: Readonly<Mat3>, c: number): Vec3 => [m[c], m[3 + c], m[6 + c]];

/** Rotation vector (axis × angle) of R: the log map. */
export function logMat(R: Readonly<Mat3>): Vec3 {
  const c = clamp((R[0] + R[4] + R[8] - 1) / 2, -1, 1);
  const a = Math.acos(c);
  if (a < 1e-7) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - a < 1e-4) {
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    if (x >= y && x >= z) return [x * a, (R[1] >= 0 ? y : -y) * a, (R[2] >= 0 ? z : -z) * a];
    if (y >= z) return [(R[1] >= 0 ? x : -x) * a, y * a, (R[5] >= 0 ? z : -z) * a];
    return [(R[2] >= 0 ? x : -x) * a, (R[5] >= 0 ? y : -y) * a, z * a];
  }
  const k = a / (2 * Math.sin(a));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

export function expMat(v: Vec3): Mat3 {
  const a = norm(v);
  if (a < 1e-12) return identity();
  return axisAngle([v[0] / a, v[1] / a, v[2] / a], a);
}

/** Re-orthonormalize (Gram-Schmidt on x then z). */
export function orthonormalize(m: Readonly<Mat3>): Mat3 {
  const x = normalize(col(m, 0));
  const y0 = col(m, 1);
  const z = normalize(cross(x, y0), [0, 0, 1]);
  const y = cross(z, x);
  return fromColumns(x, y, z);
}

/** Yaw of a frame's x axis projected on the ground. */
export const yawOfMat = (m: Readonly<Mat3>): number => Math.atan2(m[3], m[0]);

// ---------------------------------------------------------------- quaternions [w, x, y, z]

export function quatFromMat(m: Readonly<Mat3>): Quat {
  const tr = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  const q: Quat = [w, x, y, z];
  return w < 0 ? [-w, -x, -y, -z] : q;
}

export function matFromQuat(q: Readonly<Quat>): Mat3 {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function quatMul(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function quatNormalize(q: Readonly<Quat>): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Shortest-arc spherical interpolation. */
export function quatSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : [b[0], b[1], b[2], b[3]];
  d = Math.abs(d);
  if (d > 0.9995) return quatNormalize([lerp(a[0], bb[0], t), lerp(a[1], bb[1], t), lerp(a[2], bb[2], t), lerp(a[3], bb[3], t)]);
  const th = Math.acos(clamp(d, -1, 1));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** Rotation about world z by `yaw`. */
export const quatYaw = (yaw: number): Quat => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];

// ---------------------------------------------------------------- series helpers

/** Centred moving average of a scalar series (window in samples, odd). */
export function smooth(src: ArrayLike<number>, window: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  const h = Math.max(0, Math.floor(window / 2));
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) {
      s += src[k];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}
