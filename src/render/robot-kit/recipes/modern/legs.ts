// Legs of the modern electric fighters. Thighs and shins dress the collision capsules; the hip
// yaw puck hangs under the pelvis (frame 0), the hip pitch puck sits outside the thigh (frame 2),
// the knee puck in the shin's frame 0 and the ankle puck in the foot's frame 0.
//   leg.thigh / leg.shin (modern styles): egg shells (pebble), sculpted plates over aluminium
//     (blade), thick bolted slabs (slab), exposed tube thighs and hi-vis shin sleeves (hivis).
//   leg.shin.guard  SAVATE: ribbed bone-white foam guard over the shin, aubergine knee cap.
//   leg.foot.round  FIRECRACKER: rounded graphite shoe, gloss toe cap, black rubber sole.
//   leg.foot (modern styles): bone instep and aubergine heel (blade), square slab boot (slab),
//     long narrow black foot (hivis).
import * as THREE from 'three/webgpu';
import type { PartDef } from '../../../../core/types';
import { box, collar, cylinder } from '../../geom/prims';
import { limbCore, limbPlate, numberDecal } from '../common';
import { housingRadius, type RecipeContext } from '../context';
import { actuator, block, clevis, limbShell, V } from '../mech';
import { facePlate } from '../torso';
import { band, joint, limbEgg } from './kit';
import { body, capsuleT, frame, keys } from './shapes';

function childOf(ctx: RecipeContext): PartDef | undefined {
  return ctx.design.parts.find((p) => p.parent === ctx.part.id);
}

function jointBelow(ctx: RecipeContext): number {
  const c = childOf(ctx);
  return c ? -c.pos[2] : ctx.dims.length;
}

function capsuleRadius(p: PartDef | undefined, fallback: number): number {
  const g = p?.geoms.find((x) => x.shape.type === 'capsule');
  return g && g.shape.type === 'capsule' ? g.shape.radius : fallback;
}

/** Front-and-outer wrap angles for a limb shell on side s (0 = +x front). */
function wrapAngles(s: number, back = 0.35, over = 0.25): [number, number] {
  return s > 0 ? [-back, Math.PI / 2 + over] : [-Math.PI / 2 - over, back];
}

// ---------------------------------------------------------------- thigh

export function modernThigh(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = jointBelow(ctx);
  const s = ctx.side || 1;
  const fb = ctx.own;
  const [f0, f1, f2] = ctx.frames;
  if (f0 && f1 && f2 && ctx.frames.length > 3) {
    joint(ctx, f0, V(0, 0, -1), V(0, 0, r * 0.3), housingRadius(ctx.part, 0) * 0.9, r * 0.5);
    const Rr = housingRadius(ctx.part, 1) * 0.72;
    actuator(f1, V(1, 0, 0), V(0, 0, -r * 0.08), Rr, Rr * 1.25, ctx.style, { hidden: true });
    joint(ctx, f2, V(0, s, 0), V(0, s * r * 0.62, -r * 0.12), housingRadius(ctx.part, 2) * 1.02, r * 0.6);
  }
  const zTop = -r * 0.5;
  const zBot = -(L - r * 0.5);
  switch (ctx.style.limbs) {
    case 'pebble': {
      const decal = s < 0 ? numberDecal('x', [0.18, 0.42, 0.82, 0.78]) : undefined;
      limbCore(ctx, fb, zTop, zBot, r * 1.1, r * 1.05, { taper: 0.9, round: 0.48 });
      limbEgg(fb, { zTop: -r * 0.42, zBot: -(L - r * 0.62), rx: r * 1.24, ry: r * 1.18, bulge: 0.34, taper: 0.7, topTaper: 0.86, ox: r * 0.06, surf: { decal } });
      break;
    }
    case 'blade': {
      limbCore(ctx, fb, zTop, zBot, r * 1.45, r * 1.4, { taper: 0.84, round: 0.48 });
      const [a0, a1] = wrapAngles(s, 0.5, 0.35);
      limbShell(fb, r * 0.78, ctx.style.plate * 1.4, a0, a1, -r * 0.55, -(L - r * 0.8), { taper: 0.84, surf: { cavity: 0.05 } });
      break;
    }
    case 'slab':
      limbCore(ctx, fb, zTop, zBot, r * 1.5, r * 1.45, { taper: 0.86 });
      limbPlate(ctx, fb, 'front', -r * 0.6, -(L - r * 0.95), r * 0.78, { width: r * 1.6, taper: 0.85, bolts: 'edges' });
      limbPlate(ctx, fb, 'outer', -r * 0.9, -(L - r * 1.0), r * 0.78, { width: r * 1.45, taper: 0.88, bolts: 'corners' });
      limbPlate(ctx, fb, 'inner', -r * 1.0, -(L - r * 1.1), r * 0.74, { width: r * 1.1, taper: 0.9, bolts: 'none', thick: ctx.style.plate * 0.7 });
      break;
    case 'hivis':
      fb.add('frame', cylinder(r * 0.6, zBot, zTop, 28, 0.004), undefined, { cavity: 0.3 });
      band(fb, zTop - 0.012, r * 0.6, r * 0.7, 0.016);
      band(fb, zBot + 0.016, r * 0.6, r * 0.7, 0.016);
      break;
    default:
  }
  const rc = capsuleRadius(childOf(ctx), r * 0.85);
  if (ctx.style.limbs === 'slab') clevis(fb, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), rc * 1.5, rc * 0.9, Math.max(0.012, r * 0.16), L * 0.26, { cavity: 0.2 });
  else clevis(fb, 'mech', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), rc * 1.46, rc * 0.62, Math.max(0.008, r * 0.1), L * 0.16, { cavity: 0.3 });
}

// ---------------------------------------------------------------- shin

function kneePuck(ctx: RecipeContext, r: number): void {
  const s = ctx.side || 1;
  const f0 = ctx.frames[0];
  if (f0 && ctx.frames.length > 1) joint(ctx, f0, V(0, s, 0), V(0, 0, 0), housingRadius(ctx.part, 0), r * 1.44, { back: true });
  ctx.own.add('mech', cylinder(r * 0.66, -r * 0.7, r * 0.7, 28, 0.006), frame(V(1, 0, 0), V(0, 0, -1), V(0, 1, 0), V(0, 0, 0)), { cavity: 0.3 });
}

function ankleFork(ctx: RecipeContext, r: number, L: number): void {
  if (ctx.style.limbs === 'slab') clevis(ctx.own, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.1, r * 0.7, Math.max(0.01, r * 0.15), L * 0.22, { cavity: 0.2 });
  else clevis(ctx.own, 'mech', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.0, r * 0.5, Math.max(0.007, r * 0.1), L * 0.14, { cavity: 0.3 });
}

export function modernShin(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = jointBelow(ctx);
  const fb = ctx.own;
  kneePuck(ctx, r);
  switch (ctx.style.limbs) {
    case 'pebble':
      limbCore(ctx, fb, -r * 0.7, -(L - r * 0.4), r * 1.1, r * 1.05, { taper: 0.85, round: 0.48 });
      limbEgg(fb, { zTop: -r * 0.95, zBot: -(L - r * 0.45), rx: r * 1.22, ry: r * 1.14, bulge: 0.3, taper: 0.64, topTaper: 0.84, ox: r * 0.1 });
      break;
    case 'slab':
      limbCore(ctx, fb, -r * 0.7, -(L - r * 0.4), r * 1.45, r * 1.4, { taper: 0.85 });
      facePlate(ctx, fb, V(r * 0.8, 0, -r * 0.3), V(1, 0, 0.45), r * 1.2, r * 1.5, { bolts: 'corners', thick: ctx.style.plate });
      limbPlate(ctx, fb, 'front', -r * 1.3, -(L - r * 0.7), r * 0.74, { width: r * 1.6, taper: 0.8, bolts: 'edges' });
      limbPlate(ctx, fb, 'outer', -r * 1.2, -(L - r * 1.0), r * 0.74, { width: r * 1.35, taper: 0.85, bolts: 'corners' });
      limbPlate(ctx, fb, 'inner', -r * 1.2, -(L - r * 1.0), r * 0.72, { width: r * 1.2, taper: 0.85, bolts: 'none', thick: ctx.style.plate * 0.7 });
      break;
    case 'hivis':
      limbCore(ctx, fb, -r * 0.7, -(L - r * 0.4), r * 1.0, r * 0.95, { taper: 0.9, round: 0.48 });
      limbEgg(fb, { zTop: -r * 1.25, zBot: -(L - r * 0.25), rx: r * 1.06, ry: r * 1.0, bulge: 0.25, taper: 0.78, topTaper: 0.92, end: 5 });
      band(fb, -r * 1.2, r * 0.8, r * 0.96, 0.016);
      band(fb, -(L - r * 0.35), r * 0.7, r * 0.86, 0.016);
      break;
    default:
      limbCore(ctx, fb, -r * 0.7, -(L - r * 0.4), r * 1.4, r * 1.35, { taper: 0.85, round: 0.48 });
  }
  ankleFork(ctx, r, L);
}

/** SAVATE: ribbed bone-white foam shin guard over an aluminium shin, aubergine knee cap. */
export function shinGuard(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = jointBelow(ctx);
  const fb = ctx.own;
  kneePuck(ctx, r);
  limbCore(ctx, fb, -r * 0.7, -(L - r * 0.4), r * 1.35, r * 1.3, { taper: 0.85, round: 0.48 });
  facePlate(ctx, fb, V(r * 0.72, 0, -r * 0.35), V(1, 0, 0.5), r * 1.25, r * 1.35, { bolts: 'none', thick: ctx.style.plate * 1.3 });
  // The guard: thick foam wrapped round the front and sides, with raised ribs across it.
  const rIn = r * 0.72;
  const thick = r * 0.26;
  const zTop = -r * 1.3;
  const zBot = -(L - r * 0.05);
  const a = 1.4;
  limbShell(fb, rIn, thick, -a, a, zTop, zBot, { taper: 0.86, slot: 'trim', surf: { cavity: 0.06, decal: numberDecal('x', [0.25, 0.48, 0.75, 0.68]) } });
  const ribs = 4;
  for (let k = 0; k < ribs; k++) {
    const z = zTop - (zTop - zBot) * (0.1 + (0.62 * k) / (ribs - 1));
    const t = (zTop - z) / (zTop - zBot);
    const scale = 1 + (0.86 - 1) * t;
    const w = (zTop - zBot) * 0.035;
    limbShell(fb, (rIn + thick) * scale - 0.002, 0.006, -a + 0.2, a - 0.2, z + w, z - w, { slot: 'trim', surf: { cavity: 0.15 } });
  }
  ankleFork(ctx, r, L);
}

// ---------------------------------------------------------------- feet

interface FootBox {
  wx: number;
  wy: number;
  cx: number;
  x0: number;
  x1: number;
  zb: number;
  zt: number;
}

function footBox(ctx: RecipeContext): FootBox {
  const d = ctx.dims;
  return { wx: d.size.x, wy: d.size.y, cx: d.center.x, x0: d.min.x, x1: d.max.x, zb: d.min.z, zt: d.max.z };
}

/** Ankle pitch puck (frame 0), hidden roll stator (frame 1) and the roll yoke. */
function ankle(ctx: RecipeContext, f: FootBox): void {
  const s = ctx.side || 1;
  const [f0, f1] = ctx.frames;
  if (f0 && f1 && ctx.frames.length > 2) {
    joint(ctx, f0, V(0, s, 0), V(0, 0, 0), housingRadius(ctx.part, 0) * 0.7, f.wy * 0.6, { back: true });
    actuator(f1, V(1, 0, 0), V(0, 0, -0.004), f.wy * 0.22, f.wy * 0.46, ctx.style, { hidden: true });
  }
  if (ctx.style.limbs === 'slab') clevis(ctx.own, 'frame', V(1, 0, 0), V(0, 0, -0.004), V(0, 0, -1), f.wy * 0.46, f.wy * 0.24, 0.01, Math.max(0.02, -f.zt), { cavity: 0.2 });
  else ctx.own.add('mech', cylinder(f.wy * 0.2, -Math.max(0.03, -f.zt * 1.4), -0.004, 20, 0.003), undefined, { cavity: 0.3 });
}

/** A shoe-shaped loft running heel → toe along +x. `h(t)`/`w(t)` are half-height and half-width. */
function shoe(x0: number, x1: number, zc: (t: number) => number, h: (t: number) => number, w: (t: number) => number, power = 2.4, end = 3.2): THREE.BufferGeometry {
  const g = body(x0, x1, 18, (t) => {
    const env = capsuleT(t, end);
    return { rx: h(t) * env, ry: w(t) * env, ox: zc(t) };
  }, { segs: 32, power });
  // Build z → +x (length), build x → +z (height), build y → y. That is a mirror, so flip the
  // triangle winding back to match the (correctly transformed) normals.
  g.applyMatrix4(frame(V(0, 0, 1), V(0, 1, 0), V(1, 0, 0), V(0, 0, 0)));
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
  return g;
}

/** Rounded rubber sole following the shoe outline (square for the slab boot). */
function sole(ctx: RecipeContext, f: FootBox, thick: number, widthK = 1): void {
  if (ctx.style.limbs === 'slab') {
    ctx.own.add('rubber', box(f.wx * 0.99, f.wy * widthK, thick, { bevel: Math.min(0.008, thick * 0.4), cell: 0.04 }), new THREE.Matrix4().makeTranslation(f.cx, 0, f.zb + thick / 2), { color: '#111111', cavity: 0.2 });
    return;
  }
  const g = shoe(f.x0, f.x1, () => f.zb + thick / 2, () => thick / 2, (t) => f.wy * 0.5 * widthK * keys(t, [[0, 0.86], [0.55, 1], [1, 0.92]]), 3.4, 2.2);
  ctx.own.add('rubber', g, undefined, { color: '#111111', cavity: 0.2 });
}

/** FIRECRACKER: rounded graphite shoe shell, gloss toe cap, black rubber sole. */
export function footRound(ctx: RecipeContext): void {
  const f = footBox(ctx);
  ankle(ctx, f);
  roundShoe(ctx, f);
}

function roundShoe(ctx: RecipeContext, f: FootBox): void {
  const soleT = (f.zt - f.zb) * 0.3;
  sole(ctx, f, soleT, 1.02);
  const zBase = f.zb + soleT;
  const hMax = Math.max(0.035, -zBase * 0.82);
  // Graphite shoe shell rising to the ankle at the back, low over the toes.
  ctx.own.add('frame', shoe(f.x0 + f.wx * 0.01, f.x1 - f.wx * 0.03,
    (t) => zBase + hMax * keys(t, [[0, 0.95], [0.45, 0.85], [0.8, 0.5], [1, 0.4]]),
    (t) => hMax * keys(t, [[0, 1], [0.45, 0.9], [0.8, 0.52], [1, 0.42]]),
    (t) => f.wy * 0.48 * keys(t, [[0, 0.84], [0.5, 1], [1, 0.9]]), 2.4, 2.6), undefined, { cavity: 0.2 });
  // Gloss toe cap: a dome over the front third.
  ctx.own.add('paint', shoe(f.cx - f.wx * 0.02, f.x1 + f.wx * 0.015,
    (t) => zBase + hMax * keys(t, [[0, 0.5], [1, 0.36]]),
    (t) => hMax * keys(t, [[0, 0.66], [0.6, 0.62], [1, 0.48]]),
    (t) => f.wy * 0.52 * keys(t, [[0, 1], [1, 0.9]]), 2.3, 2.4), undefined, { cavity: 0.05 });
}

/** Modern feet for designs that use the generic leg.foot. */
export function modernFoot(ctx: RecipeContext): void {
  const f = footBox(ctx);
  const fb = ctx.own;
  ankle(ctx, f);
  switch (ctx.style.limbs) {
    case 'blade': {
      const soleT = (f.zt - f.zb) * 0.34;
      sole(ctx, f, soleT, 0.96);
      const zBase = f.zb + soleT;
      const hMax = Math.max(0.03, -zBase * 0.5);
      fb.add('mech', shoe(f.x0 + f.wx * 0.02, f.x1 - f.wx * 0.03, (t) => zBase + hMax * 0.9 * keys(t, [[0, 1], [0.6, 0.8], [1, 0.45]]), (t) => hMax * keys(t, [[0, 1], [0.6, 0.8], [1, 0.45]]), () => f.wy * 0.46), undefined, { cavity: 0.3 });
      // Bone instep cover and an aubergine heel counter.
      fb.add('trim', shoe(f.cx - f.wx * 0.12, f.x1 - f.wx * 0.01, (t) => zBase + hMax * keys(t, [[0, 1.1], [1, 0.45]]), (t) => hMax * keys(t, [[0, 0.9], [1, 0.5]]) * 0.92, () => f.wy * 0.49), undefined, { cavity: 0.05 });
      fb.add('paint', shoe(f.x0 - f.wx * 0.01, f.x0 + f.wx * 0.3, () => zBase + hMax * 0.7, (t) => hMax * 0.8 * keys(t, [[0, 1], [1, 0.9]]), () => f.wy * 0.5), undefined, { cavity: 0.05 });
      break;
    }
    case 'slab': {
      // Wide square boot: thick tread sole, slab upper, bolted top plate.
      const soleT = (f.zt - f.zb) * 0.42;
      sole(ctx, f, soleT, 1.02);
      for (let k = 0; k < 4; k++) block(fb, 'rubber', V(f.x0 + f.wx * (0.14 + k * 0.24), 0, f.zb + 0.004), V(1, 0, 0), V(0, 1, 0), [f.wx * 0.16, f.wy * 1.02, 0.01], { color: '#0d0d0d', cavity: 0.4 });
      const zBase = f.zb + soleT;
      const hTop = Math.max(0.035, -zBase * 0.6);
      block(fb, 'paint', V(f.cx, 0, zBase + hTop * 0.5), V(1, 0, 0), V(0, 1, 0), [f.wx * 0.96, f.wy * 0.98, hTop], { cavity: 0.1 });
      facePlate(ctx, fb, V(f.cx - f.wx * 0.08, 0, zBase + hTop), V(0.1, 0, 1), f.wx * 0.5, f.wy * 0.8, { bolts: 'corners', thick: ctx.style.plate * 0.7 });
      facePlate(ctx, fb, V(f.x1 - f.wx * 0.06, 0, zBase + hTop * 0.5), V(1, 0, 0.3), hTop * 0.9, f.wy * 0.9, { bolts: 'none', thick: ctx.style.plate * 0.6 });
      break;
    }
    case 'hivis': {
      const soleT = (f.zt - f.zb) * 0.32;
      sole(ctx, f, soleT, 0.9);
      const zBase = f.zb + soleT;
      const hMax = Math.max(0.028, -zBase * 0.45);
      fb.add('mech', shoe(f.x0 + f.wx * 0.01, f.x1, (t) => zBase + hMax * 0.85 * keys(t, [[0, 1], [0.5, 0.7], [1, 0.3]]), (t) => hMax * keys(t, [[0, 1], [0.5, 0.72], [1, 0.3]]), (t) => f.wy * 0.44 * keys(t, [[0, 0.9], [0.6, 1], [1, 0.8]])), undefined, { cavity: 0.25 });
      fb.add('trim', collar(f.wy * 0.2, f.wy * 0.3, -0.03, -0.018, 28));
      break;
    }
    default:
      roundShoe(ctx, f);
  }
}
