// Small transform helpers for placing generated parts in a z-up part frame.
import * as THREE from 'three/webgpu';

export type V3 = [number, number, number];

const Z = new THREE.Vector3(0, 0, 1);

/** Rotation that takes local +z onto `dir`, with an optional roll about `dir`. */
export function quatZTo(dir: THREE.Vector3, roll = 0): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromUnitVectors(Z, dir.clone().normalize());
  if (roll !== 0) q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, roll));
  return q;
}

/** Place a z-aligned build at `pos` with its +z along `dir`. */
export function alongZ(pos: V3 | THREE.Vector3, dir: V3 | THREE.Vector3, roll = 0, scale: number | V3 = 1): THREE.Matrix4 {
  const p = Array.isArray(pos) ? new THREE.Vector3(...pos) : pos;
  const d = Array.isArray(dir) ? new THREE.Vector3(...dir) : dir;
  const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale);
  return new THREE.Matrix4().compose(p, quatZTo(d, roll), s);
}

/** Mirror across the part's sagittal plane (y → -y). */
export const MIRROR_Y = new THREE.Matrix4().makeScale(1, -1, 1);

/** Deterministic PRNG (mulberry32) for per-robot variation. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
