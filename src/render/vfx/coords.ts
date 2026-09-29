// Shared helpers for the VFX module. Every effect lives directly in the three.js scene
// (y-up). Physics data (z-up, MuJoCo) is converted once at the boundary with toWorld().
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../core/types';

/** Canvas surface height in world space (the canvas mesh sits at physics z = 0). */
export const FLOOR_Y = 0;
export const GRAVITY = 9.81;

/**
 * Physics (x, y, z) z-up → world (x, z, -y) y-up. Matches stage.physicsRoot, which is
 * rotated -90° about x.
 */
export function toWorld(v: Readonly<Vec3>, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v[0], v[2], -v[1]);
}

/** Same as toWorld but reads three floats from a flat array (e.g. the pose buffer). */
export function toWorldAt(arr: ArrayLike<number>, i: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(arr[i], arr[i + 2], -arr[i + 1]);
}

/** Small, fast, seedable PRNG (mulberry32) so effects can be reproduced in tests. */
export function makeRng(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Uniform random unit vector. */
export function randomUnit(rng: Rng, out = new THREE.Vector3()): THREE.Vector3 {
  const z = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

/**
 * Random direction inside a cone of half-angle `spread` (radians) around `axis`
 * (which must be unit length).
 */
export function randomInCone(rng: Rng, axis: THREE.Vector3, spread: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cosMax = Math.cos(spread);
  const z = cosMax + (1 - cosMax) * rng();
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const t1 = Math.abs(axis.y) < 0.9 ? tmpUp.set(0, 1, 0) : tmpUp.set(1, 0, 0);
  const u = tmpU.crossVectors(axis, t1).normalize();
  const v = tmpV.crossVectors(axis, u);
  return out.copy(axis).multiplyScalar(z).addScaledVector(u, r * Math.cos(a)).addScaledVector(v, r * Math.sin(a));
}
const tmpUp = new THREE.Vector3();
const tmpU = new THREE.Vector3();
const tmpV = new THREE.Vector3();

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Exponential decay factor for a rate per second over dt, frame-rate independent. */
export function decay(ratePerS: number, dt: number): number {
  return Math.exp(-ratePerS * dt);
}
