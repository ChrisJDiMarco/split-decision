// Arms of the modern electric fighters (arm.upper / arm.fore when the design's limb style is
// modern). Same frame layout as the plated arms: shoulder pitch puck on the torso (frame 0), the
// roll stator and shoulder cap turn with pitch (frame 1), the yaw ring turns with pitch and roll
// (frame 2); the elbow puck sits in the forearm's frame 0 on the upper arm.
//   pebble  graphite tube upper arm under a gloss shoulder dome, slim ribbed graphite forearm.
//   blade   brushed-aluminium arm with a sculpted shoulder shell and a moulded forearm cover.
//   slab    bolted slab panels, and the huge rounded shoulder cowl that rises beside the head.
//   hivis   exposed dark tube, hi-vis forearm sleeve, retroreflective bands at every joint.
import * as THREE from 'three/webgpu';
import { DECAL } from '../../types';
import { cylinder, lathe, shell } from '../../geom/prims';
import { alongZ } from '../../geom/xf';
import { limbCore, limbPlate } from '../common';
import { housingRadius, type RecipeContext } from '../context';
import { actuator, basis, clevis, V } from '../mech';
import { band, joint, limbEgg, ribbedSleeve } from './kit';
import { body, capsuleT } from './shapes';

function capsuleOf(ctx: RecipeContext, partId: string): { r: number; L: number } {
  const p = ctx.design.parts.find((q) => q.id === partId);
  const g = p?.geoms.find((x) => x.shape.type === 'capsule' || x.shape.type === 'cylinder');
  if (!g || (g.shape.type !== 'capsule' && g.shape.type !== 'cylinder')) return { r: ctx.dims.radius, L: ctx.dims.length };
  const s = g.shape;
  return { r: s.radius, L: Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]) };
}

/** Shoulder: pitch puck between torso and arm, hidden roll stator, cap, yaw ring. */
function shoulder(ctx: RecipeContext, r: number): void {
  const s = ctx.side || 1;
  const [f0, f1, f2] = ctx.frames;
  const torsoHalfY = ctx.parentDims ? ctx.parentDims.size.y / 2 : Math.abs(ctx.part.pos[1]) * 0.8;
  const gap = Math.max(0.02, Math.abs(ctx.part.pos[1]) - torsoHalfY);
  const R0 = housingRadius(ctx.part, 0);
  const W0 = gap + 0.012;
  joint(ctx, f0, V(0, s, 0), V(0, s * (W0 / 2 - gap), 0), R0, W0);
  if (!f1 || !f2) return;
  const R1 = housingRadius(ctx.part, 1) * 0.75;
  actuator(f1, V(1, 0, 0), V(0, s * 0.01, -0.005), R1, R1 * 1.2, ctx.style, { hidden: true });
  shoulderCap(ctx, r, R0);
  joint(ctx, f2, V(0, 0, 1), V(0, 0, -r * 0.95), r * 1.02, r * 0.42);
}

function shoulderCap(ctx: RecipeContext, r: number, R0: number): void {
  const s = ctx.side || 1;
  const [f0, f1] = ctx.frames;
  switch (ctx.style.limbs) {
    case 'pebble':
    case 'hivis': {
      // Rounded dome over the top and outside of the shoulder.
      const k = ctx.style.limbs === 'pebble' ? 1.5 : 1.3;
      const g = body(-r * 0.55, r * 1.25, 14, (t) => {
        const env = capsuleT(t, 2.2);
        return { rx: r * k * env, ry: r * k * 0.95 * env, oy: s * r * 0.28 };
      }, { segs: 32 });
      f1.add('paint', g, undefined, { cavity: 0.08 });
      if (ctx.style.limbs === 'hivis') band(f1, -r * 0.62, r * 0.9, r * 1.02, 0.012);
      break;
    }
    case 'blade': {
      // Sculpted shell over the top and outside, like a raked shoulder plate.
      const rIn = Math.max(R0 * 1.05, r * 1.25);
      const thick = ctx.style.plate * 1.2;
      const half = r * 1.35;
      const g = shell(rIn, rIn + thick, -0.6, 2.05, -half, half, { arcSegs: 16 });
      f1.add('paint', g, basis(V(0, 0, 1), V(0, s, 0), V(1, 0, 0), V(0, s * 0.004, 0.01)), { cavity: 0.05 });
      break;
    }
    case 'slab': {
      // The cowl: a thick dome on the torso side of the shoulder (frame 0, so it stays put while
      // the arm swings under it), its crown tilted up and out so it rises beside the head.
      const head = ctx.design.parts.find((p) => p.id === 'head');
      const headHalfY = head?.geoms[0]?.shape.type === 'box' ? head.geoms[0].shape.halfSize[1] : r * 1.5;
      const Rc = THREE.MathUtils.clamp((Math.abs(ctx.part.pos[1]) - headHalfY) * 0.86, r * 1.8, r * 3.0);
      const t = ctx.style.plate * 1.2;
      const phiMax = 1.7; // radians from the crown: a little past the equator
      const pairs: Array<[number, number, (0 | 1)?]> = [[0, Rc - t, 0]];
      const n = 12;
      for (let k = 1; k <= n; k++) {
        const a = (k / n) * phiMax;
        pairs.push([Math.sin(a) * (Rc - t), Math.cos(a) * (Rc - t), k === n ? 1 : 0]);
      }
      for (let k = n; k >= 0; k--) {
        const a = (k / n) * phiMax;
        pairs.push([Math.sin(a) * Rc, Math.cos(a) * Rc, k === n ? 1 : 0]);
      }
      const crown = V(0, s * 0.38, 0.92).normalize();
      const centre = V(-r * 0.05, -s * r * 0.7, r * 0.45);
      const m = alongZ(centre, crown);
      f0.add('paint', lathe(pairs, 44), m, { cavity: 0.12 });
      // Button-head bolts round the rim.
      const rim = Rc * Math.sin(phiMax) * 0.975;
      const zRim = Rc * Math.cos(phiMax) * 0.975 + t * 0.2;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const local = V(Math.cos(a) * rim, Math.sin(a) * rim, zRim);
        const nrm = V(Math.cos(a) * Math.sin(phiMax), Math.sin(a) * Math.sin(phiMax), Math.cos(phiMax));
        f0.bolt(local.applyMatrix4(m), nrm.transformDirection(m), ctx.style.boltSize, 'rivet');
      }
      break;
    }
    default:
  }
}

export function modernArmUpper(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const child = ctx.design.parts.find((p) => p.parent === ctx.part.id);
  const L = child ? -child.pos[2] : ctx.dims.length;
  const fb = ctx.own;
  shoulder(ctx, r);
  const zTop = -r * 1.05;
  const zBot = -(L - r * 0.3);
  switch (ctx.style.limbs) {
    case 'pebble':
      ribbedSleeve(fb, zTop, zBot, r * 0.66, r * 0.6, 3, 'frame');
      break;
    case 'blade':
      limbCore(ctx, fb, zTop, zBot, r * 1.35, r * 1.3, { taper: 0.9, round: 0.48 });
      limbPlate(ctx, fb, 'outer', zTop, -(L * 0.62), r * 0.68, { width: r * 1.3, taper: 0.85, bolts: 'none' });
      break;
    case 'slab':
      limbCore(ctx, fb, zTop, zBot, r * 1.5, r * 1.45, { taper: 0.92 });
      limbPlate(ctx, fb, 'front', zTop - 0.004, -(L - r * 0.6), r * 0.76, { width: r * 1.5, bolts: 'edges' });
      limbPlate(ctx, fb, 'outer', zTop - 0.004, -(L - r * 0.7), r * 0.76, { width: r * 1.4, bolts: 'corners' });
      limbPlate(ctx, fb, 'back', zTop - 0.004, -(L - r * 0.7), r * 0.76, { width: r * 1.3, bolts: 'corners', thick: ctx.style.plate * 0.8 });
      break;
    case 'hivis':
      fb.add('frame', cylinder(r * 0.6, zBot, zTop, 28, 0.004), undefined, { cavity: 0.3 });
      band(fb, zTop - 0.012, r * 0.6, r * 0.7, 0.014);
      band(fb, zBot + 0.014, r * 0.6, r * 0.7, 0.014);
      break;
    default:
  }
  if (ctx.style.limbs === 'slab') clevis(fb, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.5, r * 0.8, Math.max(0.01, r * 0.18), L * 0.28, { cavity: 0.2 });
  else clevis(fb, 'mech', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.46, r * 0.56, Math.max(0.007, r * 0.12), L * 0.16, { cavity: 0.3 });
}

export function modernArmFore(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = ctx.dims.length;
  const s = ctx.side || 1;
  const fb = ctx.own;
  const upper = ctx.part.parent ? capsuleOf(ctx, ctx.part.parent) : { r, L };
  const gap = upper.r * 1.5;
  const f0 = ctx.frames[0];
  if (f0 && ctx.frames.length > 1) joint(ctx, f0, V(0, s, 0), V(0, 0, 0), housingRadius(ctx.part, 0), gap * 0.94, { back: true });
  fb.add('mech', cylinder(r * 0.66, -gap * 0.46, gap * 0.46, 28, 0.006), alongZ(V(0, 0, 0), V(0, 1, 0)), { cavity: 0.3 });
  const zTop = -r * 0.7;
  const zBot = -(L - 0.01);
  switch (ctx.style.limbs) {
    case 'pebble':
      ribbedSleeve(fb, zTop, zBot, r * 0.62, r * 0.66, 6, 'frame');
      break;
    case 'blade':
      limbCore(ctx, fb, zTop, zBot, r * 1.2, r * 1.15, { taper: 1.05, round: 0.48 });
      limbEgg(fb, { zTop: -r * 0.55, zBot: -(L - r * 0.5), rx: r * 1.08, ry: r * 1.02, bulge: 0.3, taper: 0.84, topTaper: 0.8, ox: 0 });
      band(fb, -(L - r * 0.35), r * 0.7, r * 0.84, 0.014, 'frame');
      break;
    case 'slab':
      limbCore(ctx, fb, zTop, zBot, r * 1.5, r * 1.45, { taper: 1.1 });
      for (const face of ['front', 'outer', 'back', 'inner'] as const) {
        limbPlate(ctx, fb, face, -r * 0.75, -(L - r * 0.2), r * 0.76, { width: r * (face === 'front' || face === 'back' ? 1.5 : 1.35), taper: 1.12, bolts: face === 'inner' ? 'none' : 'corners' });
      }
      break;
    case 'hivis': {
      // Hi-vis sleeve; the race number runs down the right forearm.
      const decal = s < 0 ? { kind: DECAL.NUMBER, axis: '-y' as const, rect: [0.12, 0.2, 0.88, 0.8] as [number, number, number, number], rotate: true } : undefined;
      limbEgg(fb, { zTop: -r * 0.85, zBot: -(L - r * 0.15), rx: r * 1.02, ry: r * 0.98, bulge: 0.35, taper: 0.9, topTaper: 0.88, end: 5, surf: { decal } });
      band(fb, -r * 0.8, r * 0.72, r * 0.86, 0.014);
      band(fb, -(L - r * 0.2), r * 0.72, r * 0.86, 0.014);
      break;
    }
    default:
  }
  fb.add('mech', lathe([[r * 0.46, -L - 0.012, 1], [r * 0.86, -L - 0.012, 1], [r * 0.9, -L - 0.006, 0], [r * 0.9, -L + 0.016, 0], [r * 0.84, -L + 0.022, 1], [r * 0.46, -L + 0.022, 1]], 28), undefined, { cavity: 0.3 });
}
