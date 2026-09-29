// Building blocks shared by the modern electric fighters: the exposed rotary actuator in each
// style (graphite puck, ring bearing with a motor can, black finned drum, banded puck), bands
// around limbs, and moulded limb shells.
import * as THREE from 'three/webgpu';
import type { SurfOpts } from '../../geom/attrs';
import type { FrameBuilder } from '../../geom/part-builder';
import { collar, cylinder, lathe } from '../../geom/prims';
import { alongZ } from '../../geom/xf';
import type { MatSlot } from '../../types';
import type { RecipeContext } from '../context';
import { actuator, block, V, type Vec } from '../mech';
import { body, capsuleT, keys, type LoftOpts } from './shapes';

export interface JointOpts {
  back?: boolean; // detail the -axis face too (a free-standing puck)
  scale?: number; // scales the face detail (big pucks read better with bolder marks)
}

/**
 * Exposed rotary actuator on `axis` (unit) through `center`, radius R, width W. The detailed face
 * looks along +axis. Every style keeps the same footprint so joints line up with the physics.
 */
export function joint(ctx: RecipeContext, fb: FrameBuilder, axis: Vec, center: Vec, R: number, W: number, o: JointOpts = {}): void {
  const d = axis.clone().normalize();
  const h = W / 2;
  const m = alongZ(center, d);
  switch (ctx.style.limbs) {
    case 'pebble': {
      // Graphite puck: rounded rim, a recessed face and a raised index bar across it.
      const c = Math.min(R * 0.16, h * 0.5);
      const rec = Math.min(h * 0.18, 0.004);
      fb.add('mech', lathe([
        [0, -h + (o.back ? rec : 0), 1], [R * 0.62, -h + (o.back ? rec : 0), 1], [R * 0.66, -h, 1], [R - c, -h, 0], [R, -h + c, 0],
        [R, h - c, 0], [R - c, h, 0], [R * 0.66, h, 1], [R * 0.62, h - rec, 1], [0, h - rec, 1],
      ], 40), m, { cavity: 0.15 });
      fb.add('frame', collar(R * 0.62, R * 0.7, h - rec * 1.2, h + 0.0015, 36), m, { edgeMin: 0.3 });
      block(fb, 'frame', center.clone().addScaledVector(d, h - rec * 0.4), perp(d), d.clone().cross(perp(d)), [R * 1.0, R * 0.16, rec * 1.4], { edgeMin: 0.4 });
      break;
    }
    case 'blade': {
      // Crossed-roller bearing ring in brushed aluminium carrying a dark motor can.
      const lip = Math.min(0.004, h * 0.2);
      fb.add('frame', lathe([
        [R * 0.64, -h, 1], [R * 0.97, -h, 1], [R, -h + lip, 1], [R, h - lip, 1], [R * 0.97, h, 1], [R * 0.64, h, 1],
      ], 44), m, { cavity: 0.1 });
      fb.add('mech', cylinder(R * 0.64, -h * 0.94, h * 0.9, 36, R * 0.06), m, { cavity: 0.3 });
      fb.add('mech', collar(R * 0.3, R * 0.44, h * 0.9, h * 0.9 + 0.003, 28), m);
      fb.boltRing(center.clone().addScaledVector(d, h), d, R * 0.81, 10, Math.min(0.0028, R * 0.05), 'hex');
      if (o.back) fb.boltRing(center.clone().addScaledVector(d, -h), d.clone().negate(), R * 0.81, 10, Math.min(0.0028, R * 0.05), 'hex');
      break;
    }
    case 'slab':
      // Big black finned drum with bolt circles and a capped hub.
      actuator(fb, d, center, R, W, ctx.style, { fins: 3, plainBack: !o.back, hub: 0.18 });
      fb.add('mech', cylinder(R * 0.3, h, h + W * 0.1, 24, 0.002), m);
      break;
    case 'hivis': {
      // Gunmetal puck with a retroreflective band around its rim and a ring on its face.
      const c = Math.min(R * 0.12, h * 0.4);
      fb.add('mech', lathe([[0, -h, 1], [R - c, -h, 1], [R, -h + c, 0], [R, h - c, 0], [R - c, h, 1], [0, h, 1]], 36), m, { cavity: 0.15 });
      const bw = Math.min(W * 0.34, 0.016);
      fb.add('trim', collar(R * 0.96, R * 1.04, -bw / 2, bw / 2, 40), m, { edgeMin: 0.2 });
      fb.add('trim', collar(R * 0.46, R * 0.6, h, h + 0.002, 32), m);
      fb.boltRing(center.clone().addScaledVector(d, h), d, R * 0.78, 6, Math.min(0.0026, R * 0.05), 'hex', 0.3);
      if (o.back) fb.add('trim', collar(R * 0.46, R * 0.6, -h - 0.002, -h, 32), m);
      break;
    }
    default:
      actuator(fb, d, center, R, W, ctx.style, { plainBack: !o.back });
  }
}

/** Any unit vector perpendicular to `d`. */
export function perp(d: Vec): Vec {
  const ref = Math.abs(d.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0);
  return new THREE.Vector3().crossVectors(d, ref).normalize();
}

/** Thin band around a limb that runs along z (PYLON's joint bands, cuffs, collars). */
export function band(fb: FrameBuilder, z: number, rIn: number, rOut: number, width: number, slot: MatSlot = 'trim', center: Vec = V(0, 0, 0)): void {
  fb.add(slot, collar(rIn, rOut, z - width / 2, z + width / 2, 36), new THREE.Matrix4().makeTranslation(center.x, center.y, center.z), { edgeMin: 0.15 });
}

export interface ShellSpec {
  zTop: number;
  zBot: number;
  rx: number; // half-depth at the widest ring
  ry: number; // half-width at the widest ring
  bulge?: number; // t (0 top .. 1 bottom) of the widest ring
  taper?: number; // bottom section scale relative to the widest
  topTaper?: number; // top section scale relative to the widest
  ox?: number; // forward offset of the section centre
  power?: number; // section squareness
  end?: number; // end rounding exponent (2 round, 4 blunt)
  slot?: MatSlot;
  surf?: SurfOpts;
  segs?: number;
}

/**
 * Moulded closed shell around a limb running down -z: widest at `bulge`, tapering to rounded
 * ends. Used for egg thighs and shins, hi-vis sleeves and forearm covers.
 */
export function limbEgg(fb: FrameBuilder, s: ShellSpec, o: LoftOpts = {}): void {
  const bulge = s.bulge ?? 0.4;
  const taper = s.taper ?? 0.7;
  const top = s.topTaper ?? 0.85;
  const e = s.end ?? 2.6;
  const len = s.zTop - s.zBot;
  const n = Math.max(12, Math.round(len / 0.012));
  // body() runs bottom (t = 0) → top (t = 1); convert to "down the limb" u = 1 - t.
  const g = body(s.zBot, s.zTop, n, (t) => {
    const u = 1 - t;
    const w = keys(u, [[0, top], [bulge, 1], [1, taper]]);
    const env = capsuleT(t, e);
    return { rx: s.rx * w * env, ry: s.ry * w * env, ox: s.ox ?? 0 };
  }, { segs: s.segs ?? 32, power: s.power ?? 2.2, ...o });
  fb.add(s.slot ?? 'paint', g, undefined, { cavity: 0.1, ...s.surf });
}

/** Ribbed sleeve (graphite forearms, spine segments): a lathe with raised rings along -z. */
export function ribbedSleeve(fb: FrameBuilder, zTop: number, zBot: number, r0: number, r1: number, ribs: number, slot: MatSlot = 'frame', center: Vec = V(0, 0, 0)): void {
  const pairs: Array<[number, number, (0 | 1)?]> = [[0, zBot, 1], [r1 * 0.94, zBot, 1]];
  const len = zTop - zBot;
  const pitch = len / (ribs + 0.5);
  for (let k = 0; k < ribs; k++) {
    const z = zBot + pitch * (k + 0.5);
    const t = (z - zBot) / len;
    const r = r1 + (r0 - r1) * t;
    const rib = Math.min(pitch * 0.34, 0.012);
    pairs.push([r, z - rib, 1], [r * 1.08, z - rib * 0.5, 0], [r * 1.08, z + rib * 0.5, 0], [r, z + rib, 1]);
  }
  pairs.push([r0 * 0.94, zTop, 1], [0, zTop, 1]);
  fb.add(slot, lathe(pairs, 28), new THREE.Matrix4().makeTranslation(center.x, center.y, center.z), { cavity: 0.35 });
}
