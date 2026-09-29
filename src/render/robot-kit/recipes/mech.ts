// Mechanical building blocks shared by every recipe: actuator housings on joint axes, clevis
// forks, pins, armor slabs with fasteners, cables, hoses with crimp fittings and vent grilles.
import * as THREE from 'three/webgpu';
import type { SurfOpts } from '../geom/attrs';
import type { BoltKind, FrameBuilder } from '../geom/part-builder';
import { box, cylinder, drum, extrude, shell, tube } from '../geom/prims';
import { prismStations, roundedRectProfile, sweep } from '../geom/sweep';
import { alongZ } from '../geom/xf';
import type { MatSlot } from '../types';
import type { KitStyle } from './context';

export type Vec = THREE.Vector3;

const SLAB_CELL_M = 0.04; // armor grid spacing: fine enough for dents, cheap enough for 2 robots

export const V = (x: number, y: number, z: number): Vec => new THREE.Vector3(x, y, z);

/** Matrix taking build x → u, y → v, z → w, then translating to `pos`. */
export function basis(u: Vec, v: Vec, w: Vec, pos: Vec): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(u.clone().normalize(), v.clone().normalize(), w.clone().normalize()).setPosition(pos);
}

// ---------------------------------------------------------------- actuators

export interface ActuatorOpts {
  fins?: number;
  plainBack?: boolean;
  bolts?: number;
  hub?: number;
  hidden?: boolean; // mostly buried: fewer segments, no face bolts on the back
}

/** Rotary actuator housing centered on `center`, axis `dir`; the detailed face looks along +dir. */
export function actuator(fb: FrameBuilder, dir: Vec, center: Vec, R: number, W: number, style: KitStyle, o: ActuatorOpts = {}): void {
  const d = dir.clone().normalize();
  const segs = o.hidden ? 16 : R > 0.06 ? 28 : 22;
  fb.add('mech', drum(R, W, { fins: o.fins, plainBottom: o.plainBack || o.hidden, hub: o.hub, segs }), alongZ(center, d), { cavity: 0.15 });
  if (o.hidden) return;
  const n = o.bolts ?? Math.max(5, Math.min(12, Math.round(R * 150)));
  const size = Math.min(style.boltSize * 0.8, R * 0.09);
  fb.boltRing(center.clone().addScaledVector(d, W / 2), d, R * 0.62, n, size, 'hex', 0.2);
  if (!o.plainBack) fb.boltRing(center.clone().addScaledVector(d, -W / 2), d.clone().negate(), R * 0.62, n, size, 'hex', 0.2);
}

/** Output flange: a thin bolted disc that turns with the joint. */
export function flange(fb: FrameBuilder, dir: Vec, center: Vec, R: number, T: number, style: KitStyle): void {
  const d = dir.clone().normalize();
  fb.add('mech', cylinder(R, -T / 2, T / 2, 28, T * 0.3), alongZ(center, d), { cavity: 0.1 });
  fb.boltRing(center.clone().addScaledVector(d, T / 2), d, R * 0.75, 8, Math.min(style.boltSize * 0.7, R * 0.1), 'hex');
}

/** Pin through a joint with nuts on both ends. */
export function pin(fb: FrameBuilder, dir: Vec, center: Vec, r: number, len: number): void {
  const d = dir.clone().normalize();
  fb.add('chrome', cylinder(r, -len / 2, len / 2, 14), alongZ(center, d));
  for (const s of [-1, 1]) {
    const c = center.clone().addScaledVector(d, (s * len) / 2);
    fb.add('mech', cylinder(r * 1.7, -r * 0.45, r * 0.45, 6, r * 0.2), alongZ(c, d));
  }
}

/** Tongue-shaped plate: round around a pin at the origin, extending along +x to `len`. */
function tongueShape(R: number, len: number, tip: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(len, -tip);
  s.lineTo(0, -R);
  s.absarc(0, 0, R, -Math.PI / 2, Math.PI / 2, true);
  s.lineTo(len, tip);
  s.closePath();
  return s;
}

/** Two fork plates straddling a joint axis, reaching from the pin along `armDir`. */
export function clevis(fb: FrameBuilder, slot: MatSlot, axis: Vec, center: Vec, armDir: Vec, gap: number, R: number, T: number, len: number, surf: SurfOpts = {}): void {
  const w = axis.clone().normalize();
  const u = armDir.clone().addScaledVector(w, -armDir.dot(w)).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);
  const shape = tongueShape(R, len, R * 0.85);
  for (const s of [-1, 1]) {
    const c = center.clone().addScaledVector(w, s * (gap / 2 + T / 2));
    fb.add(slot, extrude(shape, T, T * 0.22, 1, 10), basis(u, v, w, c), surf);
  }
}

// ---------------------------------------------------------------- armor

export interface SlabSpec {
  center: Vec;
  u: Vec; // length direction
  v: Vec; // width direction; the face normal is u × v
  lenU: number;
  lenV: number;
  thick: number;
  slot?: MatSlot;
  taper?: number; // width scale at the +u end
  bevel?: number;
  round?: boolean;
  surf?: SurfOpts;
  bolts?: 'corners' | 'edges' | 'none';
  boltKind?: BoltKind;
}

/** Armor slab: a beveled plate swept along u, so its face is a dentable grid. */
export function slab(fb: FrameBuilder, style: KitStyle, s: SlabSpec): void {
  const u = s.u.clone().normalize();
  const v = s.v.clone().addScaledVector(u, -s.v.dot(u)).normalize();
  const w = new THREE.Vector3().crossVectors(u, v);
  const b = Math.min(s.bevel ?? s.thick * 0.45, s.thick * 0.48, s.lenV * 0.2);
  const round = s.round ?? style.round;
  const profile = roundedRectProfile(s.lenV, s.thick, b, { cornerSegs: round ? 3 : 1, cell: SLAB_CELL_M });
  const st = prismStations(-s.lenU / 2, s.lenU / 2, b, {
    inset: [Math.max(0.1, (s.lenV - 2 * b) / s.lenV), Math.max(0.1, (s.thick - 2 * b) / s.thick)],
    segs: Math.max(1, Math.round(s.lenU / SLAB_CELL_M)),
    taperTop: s.taper,
    taperAxes: 'x',
    endSegs: round ? 2 : 1,
  });
  // Build axes: profile x = width (v), profile y = thickness (w), sweep z = length (u).
  fb.add(s.slot ?? 'paint', sweep(profile, st), basis(v, w, u, s.center), s.surf);
  slabBolts(fb, style, s, u, v, w);
}

function slabBolts(fb: FrameBuilder, style: KitStyle, s: SlabSpec, u: Vec, v: Vec, w: Vec): void {
  const mode = s.bolts ?? 'corners';
  if (mode === 'none') return;
  const size = style.boltSize;
  const kind = s.boltKind ?? style.boltKind;
  const face = s.center.clone().addScaledVector(w, s.thick / 2);
  const du = s.lenU / 2 - size * 2.6;
  const dv = s.lenV / 2 - size * 2.6;
  if (du <= 0 || dv <= 0) return;
  const widthAt = (a: number) => (s.taper ? 1 + (s.taper - 1) * (a * 0.5 + 0.5) : 1);
  const pt = (a: number, bb: number) => face.clone().addScaledVector(u, a * du).addScaledVector(v, bb * dv * widthAt(a));
  if (mode === 'corners') {
    for (const [a, bb] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) fb.bolt(pt(a, bb), w, size, kind);
    return;
  }
  const nU = Math.max(2, Math.round((s.lenU / 0.06) * style.boltDensity));
  for (const bb of [-1, 1]) fb.boltLine(pt(-1, bb), pt(1, bb), w, nU, size, kind);
}

export interface ShellSpec {
  taper?: number;
  slot?: MatSlot;
  surf?: SurfOpts;
  center?: Vec;
}

/** Curved armor around a limb that runs down -z: arc a0..a1 (0 = +x front), from zTop down to zBot. */
export function limbShell(fb: FrameBuilder, rIn: number, thick: number, a0: number, a1: number, zTop: number, zBot: number, o: ShellSpec = {}): void {
  const g = shell(rIn, rIn + thick, a0, a1, 0, zTop - zBot, { taper: o.taper });
  const c = o.center ?? V(0, 0, 0);
  // shell() grows along +z; mirror z so the untapered end sits at zTop (winding is fixed by add()).
  const flip = new THREE.Matrix4().makeScale(1, 1, -1).setPosition(c.x, c.y, c.z + zTop);
  fb.add(o.slot ?? 'paint', g, flip, o.surf);
}

/** Small chamfered box along arbitrary axes (brackets, slats, blocks). */
export function block(fb: FrameBuilder, slot: MatSlot, center: Vec, u: Vec, v: Vec, size: [number, number, number], surf: SurfOpts = {}, round = false): void {
  const w = new THREE.Vector3().crossVectors(u, v).normalize();
  const [a, b, c] = size;
  fb.add(slot, box(a, b, c, { bevel: Math.min(a, b, c) * 0.2, cell: 0.05, round }), basis(u, v, w, center), surf);
}

// ---------------------------------------------------------------- cabling

export function cable(fb: FrameBuilder, pts: Vec[], r: number, color: string, radial = 6): void {
  fb.add('rubber', tube(pts, r, radial, 5), undefined, { color, cavity: 0.3 });
}

/** Hose with crimped steel fittings at both ends. */
export function hoseLine(fb: FrameBuilder, pts: Vec[], r: number, color: string): void {
  cable(fb, pts, r, color, 7);
  const ends: Array<[Vec, Vec]> = [
    [pts[0], pts[1].clone().sub(pts[0]).normalize()],
    [pts[pts.length - 1], pts[pts.length - 2].clone().sub(pts[pts.length - 1]).normalize()],
  ];
  for (const [p, d] of ends) {
    fb.add('mech', cylinder(r * 1.45, 0, r * 3.2, 10, r * 0.3), alongZ(p.clone().addScaledVector(d, -r * 0.4), d));
    fb.add('mech', cylinder(r * 1.75, -r * 0.6, r * 0.6, 6, r * 0.2), alongZ(p.clone().addScaledVector(d, -r * 0.2), d));
  }
}

/** Vent grille facing `n`: a border frame and angled slats, w along u by h. */
export function grille(fb: FrameBuilder, center: Vec, u: Vec, n: Vec, w: number, h: number, slats: number, depth: number, slot: MatSlot = 'frame'): void {
  const nn = n.clone().normalize();
  const uu = u.clone().addScaledVector(nn, -u.dot(nn)).normalize();
  const vv = new THREE.Vector3().crossVectors(nn, uu);
  const bar = Math.min(w, h) * 0.12;
  const border: Array<[number, number, number, number]> = [
    [0, h / 2 - bar / 2, w, bar], [0, -h / 2 + bar / 2, w, bar],
    [w / 2 - bar / 2, 0, bar, h], [-w / 2 + bar / 2, 0, bar, h],
  ];
  for (const [cu, cv, lu, lv] of border) {
    block(fb, slot, center.clone().addScaledVector(uu, cu).addScaledVector(vv, cv), uu, vv, [lu, lv, depth], { cavity: 0.3 });
  }
  const inner = h - bar * 2;
  const tilt = new THREE.Matrix4().makeRotationX(-0.55);
  for (let i = 0; i < slats; i++) {
    const cv = -inner / 2 + (inner * (i + 0.5)) / slats;
    const c = center.clone().addScaledVector(vv, cv).addScaledVector(nn, -depth * 0.2);
    const sl = (inner / slats) * 0.9;
    const g = box(w - bar * 1.5, sl, depth * 0.25, { bevel: Math.min(sl, depth * 0.25) * 0.25, cell: 0.08, capRings: 0 });
    fb.add(slot, g, basis(uu, vv, nn, c).multiply(tilt), { cavity: 0.6 });
  }
}
