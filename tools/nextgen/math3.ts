// Small 3×3 rotation helpers for the NEXT GEN Phase 0 tools (row-major, column vectors).
export type V3 = [number, number, number];
export type M3 = number[]; // 9 entries, row-major

export const DEG = Math.PI / 180;

export function rx(a: number): M3 { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
export function ry(a: number): M3 { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
export function rz(a: number): M3 { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }

/** Rotation by angle a about unit axis u (Rodrigues). */
export function rAxis(u: V3, a: number): M3 {
  const [x, y, z] = u;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

export function mul(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
export const mulAll = (...ms: M3[]): M3 => ms.reduce((a, b) => mul(a, b));
export function tr(a: M3): M3 { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; }
export function apply(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
/** Angle between two directions, radians. */
export const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
/** Angle of the rotation a⁻¹·b, radians. */
export function rotAngle(a: M3, b: M3): number {
  const m = mul(tr(a), b);
  return Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2)));
}
/** MuJoCo xmat (row-major 9) from a Float64Array at offset. */
export const xmatAt = (arr: ArrayLike<number>, i: number): M3 => Array.from({ length: 9 }, (_, k) => arr[i * 9 + k]);
export const v3At = (arr: ArrayLike<number>, i: number): V3 => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
