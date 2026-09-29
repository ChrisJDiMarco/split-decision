// Hard-surface primitives built on the sweep: chamfered boxes, lathed actuator drums,
// curved armor shells, pins, tubes, extrusions and fastener heads. All are z-aligned and
// centered unless a function says otherwise; place them with the helpers in xf.ts.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { indexed } from './attrs';
import {
  arcPlateProfile, capGeometry, circleProfile, latheStations, prismStations,
  roundedPolyProfile, roundedRectProfile, sweep, type Profile, type Station,
} from './sweep';

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  if (!out) throw new Error('robot-kit: primitive merge failed');
  for (const p of parts) p.dispose();
  return out;
}

// ---------------------------------------------------------------- boxes

export interface BoxOpts {
  bevel?: number; // chamfer size, metres
  round?: boolean; // rounded vertical edges and rounded ends
  cell?: number; // target subdivision length, metres (dent resolution)
  taper?: number; // scale at +z relative to -z
  taperAxes?: 'xy' | 'x' | 'y'; // which of x / y the taper scales
  capRings?: number;
}

/** Chamfered (or rounded) box centered on the origin, sizes along x, y, z. */
export function box(sx: number, sy: number, sz: number, o: BoxOpts = {}): THREE.BufferGeometry {
  const m = Math.min(sx, sy, sz);
  const b = Math.min(o.bevel ?? m * 0.14, m * 0.45);
  const cell = o.cell ?? 0.045;
  const profile = roundedRectProfile(sx, sy, b, { cornerSegs: o.round ? 3 : 1, cell });
  const st = prismStations(-sz / 2, sz / 2, b, {
    inset: [Math.max(0.05, (sx - 2 * b) / sx), Math.max(0.05, (sy - 2 * b) / sy)],
    segs: Math.max(1, Math.round(sz / cell)),
    capRings: o.capRings ?? Math.min(3, Math.floor(Math.min(sx, sy) / (cell * 2))),
    taperTop: o.taper,
    taperAxes: o.taperAxes,
    endSegs: o.round ? 3 : 1,
  });
  return sweep(profile, st);
}

/** Prism of any CCW polygon outline (x/y), extruded along z with chamfered edges. */
export function polyPrism(outline: Array<[number, number]>, z0: number, z1: number, o: { bevel?: number; round?: boolean; cell?: number; taper?: number } = {}): THREE.BufferGeometry {
  const b = o.bevel ?? 0.01;
  const profile = roundedPolyProfile(outline, b, { cornerSegs: o.round ? 3 : 1, cell: o.cell ?? 0.045 });
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const st = prismStations(z0, z1, b, {
    inset: [Math.max(0.05, (w - 2 * b) / w), Math.max(0.05, (h - 2 * b) / h)],
    segs: Math.max(1, Math.round((z1 - z0) / (o.cell ?? 0.045))),
    taperTop: o.taper,
    endSegs: o.round ? 3 : 1,
    openBottom: true,
    openTop: true,
  });
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  // Inset rings scale about the origin; recentre so the caps shrink toward the outline centre.
  const centred = st.map((s) => ({ ...s, ox: cx * (1 - s.sx), oy: cy * (1 - (s.sy ?? s.sx)) }));
  const side = sweep(profile, centred);
  return merge([side, capGeometry(profile, centred[0], -1), capGeometry(profile, centred[centred.length - 1], 1)]);
}

// ---------------------------------------------------------------- lathed parts

/** Lathe from (radius, z, hard) pairs wrapping the solid counter-clockwise (bottom → top). */
export function lathe(pairs: Array<[number, number, (0 | 1)?]>, segs = 24, edge = 1): THREE.BufferGeometry {
  return sweep(circleProfile(1, segs), latheStations(pairs, edge));
}

export interface DrumOpts {
  segs?: number;
  hub?: number; // hub boss height as a fraction of the width
  fins?: number; // cooling grooves on the wall
  plainBottom?: boolean; // skip face detail on the -z face (mounted against a body)
}

type Pair = [number, number, (0 | 1)?];

function drumFace(R: number, h: number, c: number, g: number, hub: number, detailed: boolean): Pair[] {
  if (!detailed) return [[R, h - c, 1], [R - c, h, 1], [R * 0.3, h, 1], [0, h, 1]];
  return [
    [R, h - c, 1], [R - c, h, 1],
    [R * 0.86, h, 1], [R * 0.86, h - g, 1], [R * 0.8, h - g, 1], [R * 0.8, h, 1],
    [R * 0.46, h, 1], [R * 0.44, h + hub, 1], [R * 0.36, h + hub + c * 0.4, 1], [0, h + hub + c * 0.4, 1],
  ];
}

/** Rotary actuator housing along z, centered: machined face rings, hub boss, optional fins. */
export function drum(R: number, W: number, o: DrumOpts = {}): THREE.BufferGeometry {
  const h = W / 2;
  const c = Math.min(R * 0.09, W * 0.16);
  const g = Math.min(W * 0.08, R * 0.07);
  const hub = W * (o.hub ?? 0.12);
  const top = drumFace(R, h, c, g, hub, true);
  const bottom = drumFace(R, h, c, g, hub, !o.plainBottom).map(([r, z, k]) => [r, -z, k] as Pair).reverse();
  const wall: Pair[] = [];
  const fins = o.fins ?? 0;
  if (fins > 0) {
    const z0 = -h + c * 2;
    const span = W - c * 4;
    const pitch = span / fins;
    for (let k = 0; k < fins; k++) {
      const zc = z0 + pitch * (k + 0.5);
      const fw = pitch * 0.22;
      wall.push([R, zc - fw, 1], [R * 0.93, zc - fw, 1], [R * 0.93, zc + fw, 1], [R, zc + fw, 1]);
    }
  }
  return lathe([...bottom, ...wall, ...top], o.segs ?? 32);
}

/** Plain chamfered cylinder along z from z0 to z1 (pins, rods, barrels). */
export function cylinder(r: number, z0: number, z1: number, segs = 16, bevel = r * 0.15, capped = true): THREE.BufferGeometry {
  const b = Math.min(bevel, (z1 - z0) * 0.3, r * 0.5);
  const pairs: Pair[] = [[r - b, z0, 1], [r, z0 + b, 1], [r, z1 - b, 1], [r - b, z1, 1]];
  if (capped) pairs.unshift([0, z0, 1]);
  if (capped) pairs.push([0, z1, 1]);
  return lathe(pairs, segs);
}

/** Ring-shaped collar (torus-like band with a square section) along z. */
export function collar(rIn: number, rOut: number, z0: number, z1: number, segs = 28): THREE.BufferGeometry {
  const b = Math.min((rOut - rIn) * 0.3, (z1 - z0) * 0.3);
  return lathe([
    [rIn, z1, 1], [rIn, z0, 1], [rOut - b, z0, 1], [rOut, z0 + b, 1], [rOut, z1 - b, 1], [rOut - b, z1, 1], [rIn, z1, 1],
  ], segs);
}

// ---------------------------------------------------------------- shells

export interface ShellOpts {
  bevel?: number;
  arcSegs?: number;
  zSegs?: number;
  taper?: number; // radial scale at z1 relative to z0
}

/** Curved armor plate: an arc of a tube between angles a0..a1 (CCW from +x), from z0 to z1. */
export function shell(rIn: number, rOut: number, a0: number, a1: number, z0: number, z1: number, o: ShellOpts = {}): THREE.BufferGeometry {
  const b = o.bevel ?? Math.min((rOut - rIn) * 0.6, 0.012);
  const profile = arcPlateProfile(rIn, rOut, a0, a1, b, o.arcSegs ?? Math.max(4, Math.round(((a1 - a0) * rOut) / 0.03)));
  const t = o.taper ?? 1;
  const len = z1 - z0;
  const scaleAt = (z: number) => 1 + (t - 1) * ((z - z0) / (len || 1));
  const endIn = Math.max(0.5, (rOut - b * 0.8) / rOut);
  const zSegs = o.zSegs ?? Math.max(1, Math.round(len / 0.04));
  const st: Station[] = [{ z: z0, sx: scaleAt(z0) * endIn, edge: 1 }, { z: z0 + b, sx: scaleAt(z0 + b), edge: 1 }];
  for (let k = 0; k <= zSegs; k++) {
    const z = z0 + b * 2 + ((len - b * 4) * k) / zSegs;
    st.push({ z, sx: scaleAt(z), smooth: true });
  }
  st.push({ z: z1 - b, sx: scaleAt(z1 - b), edge: 1 }, { z: z1, sx: scaleAt(z1) * endIn, edge: 1 });
  return merge([sweep(profile, st), capGeometry(profile, st[0], -1), capGeometry(profile, st[st.length - 1], 1)]);
}

/** Closed tube shell with a custom profile (limb sleeves); open ends are capped with the profile. */
export function sleeve(profile: Profile, stations: Station[]): THREE.BufferGeometry {
  return merge([sweep(profile, stations), capGeometry(profile, stations[0], -1), capGeometry(profile, stations[stations.length - 1], 1)]);
}

// ---------------------------------------------------------------- tubes and extrusions

/** Cable or hose through points (centripetal Catmull-Rom). */
export function tube(points: THREE.Vector3[], radius: number, radial = 6, perSeg = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(2, (points.length - 1) * perSeg), radius, radial, false);
}

/** Extrude a 2D shape along z, centered, with the bevel inside the outline. */
export function extrude(shape: THREE.Shape, depth: number, bevel = 0, bevelSegs = 1, curveSegs = 8): THREE.BufferGeometry {
  const bv = Math.min(bevel, depth * 0.45);
  const core = Math.max(1e-4, depth - 2 * bv);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: bv > 0,
    bevelThickness: bv,
    bevelSize: bv,
    bevelOffset: -bv,
    bevelSegments: bevelSegs,
    curveSegments: curveSegs,
  });
  geo.translate(0, 0, -core / 2);
  geo.clearGroups();
  return indexed(geo);
}

// ---------------------------------------------------------------- fasteners (unit size)

/** Hex bolt head, across-corners radius 1, rising from below the surface to z = 0.55 (open bottom). */
export function hexBoltGeometry(): THREE.BufferGeometry {
  // Smooth-shaded hexagon: at bolt scale the facets still read, at half the vertex count.
  return sweep(circleProfile(1, 6, 0.7), [
    { z: -0.2, sx: 1 }, { z: 0.4, sx: 1, edge: 1 }, { z: 0.55, sx: 0.78, edge: 1 }, { z: 0.55, sx: 0 },
  ]);
}

/** Domed rivet, radius 1, height 0.5 (open bottom, buried in the plate). */
export function rivetGeometry(): THREE.BufferGeometry {
  return lathe([[1, -0.15, 1], [1, 0.06, 0], [0.72, 0.4, 0], [0, 0.53, 0]], 6, 0.8);
}
