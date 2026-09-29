// Moving optics. Heads build their lenses, bezels and a dim static glow ring with the rest of
// the shell; the bright part of each optic is a separate small object that eyes.ts moves every
// frame toward the gaze: a pupil sliding inside its lens, a hotspot running along a light bar or
// visor slit, or a beacon on an antenna tip. Each gets its own glow state so it can burn
// brighter than the rings around it.
import * as THREE from 'three/webgpu';
import { FrameBuilder, newObjState } from '../geom/part-builder';
import { box, lathe } from '../geom/prims';
import { quatZTo } from '../geom/xf';
import type { EyeElement } from '../types';
import type { RecipeContext } from './context';
import { V, type Vec } from './mech';

const PUPIL_PROUD_M = 0.0026; // pupil face stands this far in front of the lens glass
const SLIDER_PROUD_M = 0.0022;
const PUPIL_TRAVEL = 0.92; // share of the free space between pupil and lens rim the pupil may use

function finalize(ctx: RecipeContext, fb: FrameBuilder, name: string): { group: THREE.Group; obj: EyeElement['obj'] } {
  const obj = newObjState(0.5);
  const built = fb.finalize(ctx.mats, obj);
  built.group.name = name;
  return { group: built.group, obj };
}

/** Lateral and vertical units in the plane of a lens that looks along `dir`. */
function lensAxes(dir: Vec): { u: Vec; v: Vec } {
  const d = dir.clone().normalize();
  const up = Math.abs(d.z) > 0.95 ? V(1, 0, 0) : V(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(up, d).normalize(); // +y for a forward (+x) lens
  const v = new THREE.Vector3().crossVectors(d, u).normalize();
  return { u, v };
}

export interface PupilOpts {
  size?: number; // pupil radius as a share of the lens radius
  gain?: number;
  z?: number; // pupil face offset along dir from `center` (default: just proud of the glass)
}

/**
 * A glowing pupil inside a round lens of radius `lensR` centred at `center` (the glass face),
 * looking along `dir`. Returns the pupil radius so the caller can size its static ring.
 */
export function pupil(ctx: RecipeContext, center: Vec, dir: Vec, lensR: number, o: PupilOpts = {}): number {
  const r = lensR * (o.size ?? 0.46);
  const fb = new FrameBuilder(`${ctx.part.id}.pupil`, 31);
  const z = o.z ?? PUPIL_PROUD_M;
  // Domed disc with a bright centre bead: reads as an iris at broadcast distance.
  fb.add('glow', lathe([[0, z - 0.0016, 1], [r, z - 0.0016, 1], [r * 0.94, z, 0], [r * 0.5, z + 0.0006, 0], [0, z + 0.0009, 0]], 20));
  const { group, obj } = finalize(ctx, fb, `${ctx.part.id}:pupil`);
  group.position.copy(center);
  group.quaternion.copy(quatZTo(dir));
  ctx.own.object(group);
  const { u, v } = lensAxes(dir);
  ctx.eyes.push({ kind: 'pupil', part: ctx.part.id, object: group, obj, rest: center.clone(), u, v, travel: Math.max(0, lensR - r) * PUPIL_TRAVEL, gain: o.gain ?? 1 });
  return r;
}

export interface SliderOpts {
  length?: number; // hotspot length (m)
  width?: number; // hotspot width (m)
  depth?: number;
  gain?: number;
}

/**
 * A hotspot that runs along a straight light strip from `a` to `b` (points on the strip face)
 * whose face looks along `normal`: a Cylon sweep on visor slits.
 */
export function slider(ctx: RecipeContext, a: Vec, b: Vec, normal: Vec, o: SliderOpts = {}): void {
  const run = b.clone().sub(a);
  const len = run.length();
  const dir = run.clone().normalize();
  const hl = o.length ?? len * 0.2;
  const w = o.width ?? 0.012;
  const d = o.depth ?? 0.004;
  const fb = new FrameBuilder(`${ctx.part.id}.slider`, 37);
  // Built along x (the run), y across, z out of the face.
  fb.add('glow', box(hl, w, d, { bevel: Math.min(w, d) * 0.45, round: true, cell: 1 }), new THREE.Matrix4().makeTranslation(0, 0, d / 2 + SLIDER_PROUD_M - 0.002));
  const { group, obj } = finalize(ctx, fb, `${ctx.part.id}:slider`);
  const n = normal.clone().normalize();
  const across = new THREE.Vector3().crossVectors(n, dir).normalize();
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, across, n));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  group.position.copy(mid);
  ctx.own.object(group);
  ctx.eyes.push({ kind: 'slider', part: ctx.part.id, object: group, obj, rest: mid, u: dir, v: n, travel: Math.max(0, len / 2 - hl / 2), gain: o.gain ?? 1 });
}

/**
 * A hotspot riding a curved light bar (a polyline of points on its glowing face), e.g. SAVATE's
 * brow-to-chin bar. The drive runs from path[0] (t = 0) to the last point (t = 1).
 */
export function barSlider(ctx: RecipeContext, path: Vec[], r: number, o: { gain?: number; along?: number } = {}): void {
  const fb = new FrameBuilder(`${ctx.part.id}.bar`, 41);
  const h = r * (o.along ?? 2.6);
  fb.add('glow', lathe([[0, -h - r * 0.9, 1], [r * 0.72, -h - r * 0.62, 0], [r, -h, 0], [r, h, 0], [r * 0.72, h + r * 0.62, 0], [0, h + r * 0.9, 0]], 12));
  const { group, obj } = finalize(ctx, fb, `${ctx.part.id}:bar`);
  const mid = path[Math.floor(path.length / 2)].clone();
  group.position.copy(mid);
  group.quaternion.copy(quatZTo(path[path.length - 1].clone().sub(path[0])));
  ctx.own.object(group);
  const a = path[0];
  const b = path[path.length - 1];
  ctx.eyes.push({ kind: 'slider', part: ctx.part.id, object: group, obj, rest: mid, u: b.clone().sub(a).normalize(), v: V(1, 0, 0), travel: a.distanceTo(b) / 2, gain: o.gain ?? 1, path: path.map((p) => p.clone()) });
}

/** A small tip light (antenna beacon) at `pos`. */
export function beacon(ctx: RecipeContext, pos: Vec, r: number, gain = 1): void {
  const fb = new FrameBuilder(`${ctx.part.id}.beacon`, 43);
  const pairs: Array<[number, number, (0 | 1)?]> = [];
  for (let k = 0; k <= 6; k++) {
    const a = -Math.PI / 2 + (k / 6) * Math.PI;
    pairs.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  fb.add('glow', lathe(pairs, 12));
  const { group, obj } = finalize(ctx, fb, `${ctx.part.id}:beacon`);
  group.position.copy(pos);
  ctx.own.object(group);
  ctx.eyes.push({ kind: 'beacon', part: ctx.part.id, object: group, obj, rest: pos.clone(), u: V(0, 1, 0), v: V(0, 0, 1), travel: 0, gain });
}
