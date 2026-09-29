// Standard vertex attributes for every kit geometry, so any two kit geometries can merge.
//   aSurf   = (edge wear weight, cavity/grime, accent plate flag, per-plate variant)
//   aDecal  = (u, v, decal kind, mask)            planar decal / accent-pattern coordinates
//   aDamage = (scratch, scorch, dent depth 0..1, heat-tint memory)   written by applyImpact
//   color   = vertex tint (cables, hoses, wires); white elsewhere
import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { DECAL, type DecalKind } from '../types';

export type Axis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

export interface DecalSpec {
  kind: DecalKind;
  axis: Axis; // faces whose normal points along this axis carry the decal
  rect?: [number, number, number, number]; // sub-rect [u0, v0, u1, v1] of the projected bounds that maps to the cell
  rotate?: boolean; // swap u and v (text running along a limb)
}

export interface SurfOpts {
  cavity?: number;
  accent?: boolean;
  variant?: number;
  edgeMin?: number; // raise the whole geometry's edge weight (small parts that wear all over)
  edgeScale?: number; // scale the baked edge weights
  color?: THREE.ColorRepresentation;
  decal?: DecalSpec;
}

export const ATTR_NAMES = ['position', 'normal', 'uv', 'color', 'aSurf', 'aDecal', 'aDamage'] as const;

const AXIS_DIR: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  z: new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

// Screen-right and screen-up for a viewer looking at a face along -axis (z-up part frames).
const AXIS_UV: Record<Axis, [THREE.Vector3, THREE.Vector3]> = {
  x: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  '-x': [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
  y: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
  '-y': [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  z: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0)],
  '-z': [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)],
};

/** Edge weight for geometries that were not built by the sweep (tubes, extrusions). */
function heuristicEdge(geo: THREE.BufferGeometry): Float32Array {
  const nrm = geo.getAttribute('normal');
  const count = geo.getAttribute('position').count;
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const nz = Math.abs(nrm.getZ(i));
    const nxy = Math.hypot(nrm.getX(i), nrm.getY(i));
    out[i * 4] = Math.min(1, Math.max(0, (1 - Math.max(nz, nxy)) * 3.4));
  }
  return out;
}

/** Make sure a geometry has the full attribute set, filling defaults. Mutates and returns it. */
export function ensureAttributes(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  if (!geo.getAttribute('color')) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  if (!geo.getAttribute('aSurf')) geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(heuristicEdge(geo), 4));
  if (!geo.getAttribute('aDecal')) geo.setAttribute('aDecal', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  if (!geo.getAttribute('aDamage')) geo.setAttribute('aDamage', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  for (const name of Object.keys(geo.attributes)) {
    if (!(ATTR_NAMES as readonly string[]).includes(name)) geo.deleteAttribute(name);
  }
  return geo;
}

/** Index a geometry (three.js primitives like Extrude/Tube may be non-indexed). */
export function indexed(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  return geo.index ? geo : mergeVertices(geo, 1e-6);
}

export function applySurf(geo: THREE.BufferGeometry, opts: SurfOpts): void {
  const surf = geo.getAttribute('aSurf') as THREE.BufferAttribute;
  const count = surf.count;
  const edgeScale = opts.edgeScale ?? 1;
  const edgeMin = opts.edgeMin ?? 0;
  for (let i = 0; i < count; i++) {
    surf.setX(i, Math.min(1, Math.max(edgeMin, surf.getX(i) * edgeScale)));
    if (opts.cavity !== undefined) surf.setY(i, opts.cavity);
    if (opts.accent) surf.setZ(i, 1);
    if (opts.variant !== undefined) surf.setW(i, opts.variant);
  }
  if (opts.color !== undefined) {
    const c = new THREE.Color(opts.color);
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) col.setXYZ(i, c.r, c.g, c.b);
  }
  if (opts.decal) projectDecal(geo, opts.decal);
  if (opts.accent && !opts.decal) projectDecal(geo, { kind: DECAL.ACCENT, axis: dominantAxis(geo) });
}

function dominantAxis(geo: THREE.BufferGeometry): Axis {
  geo.computeBoundingBox();
  const s = geo.boundingBox!.getSize(new THREE.Vector3());
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());
  // Thinnest dimension is the plate normal; the sign follows which side of the part it sits on.
  if (s.x <= s.y && s.x <= s.z) return c.x >= 0 ? 'x' : '-x';
  if (s.y <= s.x && s.y <= s.z) return c.y >= 0 ? 'y' : '-y';
  return c.z >= 0 ? 'z' : '-z';
}

/** Planar projection of decal coordinates onto the faces that look along `spec.axis`. */
export function projectDecal(geo: THREE.BufferGeometry, spec: DecalSpec): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const dec = geo.getAttribute('aDecal') as THREE.BufferAttribute;
  const [right, up] = AXIS_UV[spec.axis];
  const dir = AXIS_DIR[spec.axis];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const u = p.dot(right);
    const v = p.dot(up);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const [r0, s0, r1, s1] = spec.rect ?? [0, 0, 1, 1];
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    let u = (p.dot(right) - u0) / Math.max(1e-6, u1 - u0);
    let v = (p.dot(up) - v0) / Math.max(1e-6, v1 - v0);
    if (spec.rotate) [u, v] = [v, 1 - u];
    // Map the chosen sub-rect to 0..1; outside the rect the shader clips the decal.
    const du = (u - r0) / Math.max(1e-6, r1 - r0);
    const dv = (v - s0) / Math.max(1e-6, s1 - s0);
    const facing = n.dot(dir);
    const mask = Math.min(1, Math.max(0, (facing - 0.35) / 0.35));
    dec.setXYZW(i, du, dv, spec.kind, mask);
  }
}

/** Merge geometries that all carry the standard attributes. */
export function mergeKit(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 1) return geos[0];
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('robot-kit: geometry merge failed (attribute mismatch)');
  for (const g of geos) g.dispose();
  return merged;
}

export function triangleCount(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.getAttribute('position').count / 3;
}
