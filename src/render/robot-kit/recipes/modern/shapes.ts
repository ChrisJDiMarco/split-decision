// Smooth moulded shapes for the modern electric fighters: lofts of superellipse rings (pebble
// chests, egg thigh shells, lozenge heads, padded gloves). Every loft is one sweep, so its
// surface is a regular grid the damage model can dent, with edge weight only on hard rims.
import * as THREE from 'three/webgpu';
import { profileFromPath, sweep, type PathPoint, type Profile, type Station } from '../../geom/sweep';

/** Closed superellipse |x|^p + |y|^p = 1 (p = 2 ellipse, 3-4 rounded box), CCW from +x. */
export function superProfile(segs: number, power = 2): Profile {
  const path: PathPoint[] = [];
  const e = 2 / power;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    path.push({ x: Math.sign(c) * Math.abs(c) ** e, y: Math.sign(s) * Math.abs(s) ** e, e: 0, hard: false });
  }
  return profileFromPath(path);
}

/** One cross-section of a loft: half-extents rx (along x) and ry (along y), centre offset. */
export interface Ring {
  z: number;
  rx: number;
  ry: number;
  ox?: number;
  oy?: number;
  hard?: boolean; // crisp crease at this ring (it also gets edge wear)
}

export interface LoftOpts {
  segs?: number; // profile resolution
  power?: number; // superellipse exponent of the section
  close?: boolean; // collapse the first and last rings to a point (a closed body)
  profile?: Profile; // custom section instead of the superellipse
}

/** Sweep a superellipse section through rings that run up +z (bottom → top). */
export function loft(rings: Ring[], o: LoftOpts = {}): THREE.BufferGeometry {
  const profile = o.profile ?? superProfile(o.segs ?? 36, o.power ?? 2);
  const st: Station[] = rings.map((r) => ({ z: r.z, sx: r.rx, sy: r.ry, ox: r.ox ?? 0, oy: r.oy ?? 0, smooth: !r.hard, edge: r.hard ? 1 : 0 }));
  if (o.close ?? true) {
    const a = rings[0];
    const b = rings[rings.length - 1];
    st.unshift({ z: a.z, sx: 0, sy: 0, ox: a.ox ?? 0, oy: a.oy ?? 0 });
    st.push({ z: b.z, sx: 0, sy: 0, ox: b.ox ?? 0, oy: b.oy ?? 0 });
  }
  return sweep(profile, st);
}

/** Section shape along a body: t in 0..1 from bottom to top → half-extents and offsets. */
export type SectionFn = (t: number) => { rx: number; ry: number; ox?: number; oy?: number };

/**
 * Closed body from z0 to z1 sampled with cosine spacing, so the rounded ends get the most rings.
 * The section function should shrink toward t = 0 and t = 1 for a smooth close.
 */
export function body(z0: number, z1: number, n: number, f: SectionFn, o: LoftOpts = {}): THREE.BufferGeometry {
  const rings: Ring[] = [];
  for (let k = 0; k <= n; k++) {
    const t = 0.5 - 0.5 * Math.cos((k / n) * Math.PI);
    const s = f(t);
    rings.push({ z: z0 + (z1 - z0) * t, rx: Math.max(1e-5, s.rx), ry: Math.max(1e-5, s.ry), ox: s.ox, oy: s.oy });
  }
  return loft(rings, o);
}

/** Rounded end-cap envelope: 0 at both ends, 1 in the middle; `e` > 2 flattens the ends. */
export function capsuleT(t: number, e = 2): number {
  return Math.max(0, 1 - Math.abs(2 * t - 1) ** e) ** (1 / e);
}

/** Smooth 0..1 ramp. */
export function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Linear interpolation through (t, value) keys sorted by t, eased between keys. */
export function keys(t: number, k: Array<[number, number]>): number {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, v0] = k[i - 1];
      const [t1, v1] = k[i];
      return v0 + (v1 - v0) * smooth01((t - t0) / (t1 - t0));
    }
  }
  return k[k.length - 1][1];
}

/** Matrix mapping build x → u, y → v, z → w (all unit), translated to `p`. */
export function frame(u: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3, p: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(u.clone().normalize(), v.clone().normalize(), w.clone().normalize()).setPosition(p);
}
