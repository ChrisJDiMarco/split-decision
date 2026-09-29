// Heads: head.slit (Bruiser's armored box with a glowing slit), head.twin (Striker's sleek
// helmet with twin optics), head.dome (Goliath's riveted dome with a big single optic) and
// head.visor (a generic helmet with a wide visor band). The neck turret stator lives in the
// head's joint frame on the torso, so it stays behind as the socket when the head is knocked off.
// Pupils and visor hotspots are separate moving optics (optics.ts) the gaze drives (eyes.ts).
import * as THREE from 'three/webgpu';
import { box, collar, cylinder, drum, lathe, polyPrism, shell } from '../geom/prims';
import { alongZ } from '../geom/xf';
import type { RecipeContext } from './context';
import { block, grille, V, type Vec } from './mech';
import { pupil, slider } from './optics';
import { facePlate } from './torso';

interface HeadBox {
  hx: number;
  hy: number;
  h: number; // full height
  base: number; // z of the bottom
  neckR: number;
}

function headBox(ctx: RecipeContext): HeadBox {
  const d = ctx.dims;
  return { hx: d.size.x / 2, hy: d.size.y / 2, h: d.size.z, base: d.min.z, neckR: Math.min(d.size.x, d.size.y) * 0.3 };
}

function neck(ctx: RecipeContext, b: HeadBox): void {
  const f0 = ctx.frames[0];
  if (f0 && ctx.frames.length > 1) {
    f0.add('mech', collar(b.neckR * 0.45, b.neckR, -0.024, 0.004, 32), undefined, { cavity: 0.3 });
    f0.boltRing(V(0, 0, 0.004), V(0, 0, 1), b.neckR * 0.75, 8, ctx.style.boltSize * 0.7, 'hex');
    f0.add('frame', cylinder(b.neckR * 0.35, -0.02, 0.012, 20), undefined, { cavity: 0.5 });
  }
  ctx.own.add('mech', collar(b.neckR * 0.4, b.neckR * 0.95, 0.002, 0.02, 32), undefined, { cavity: 0.3 });
}

/** Round optic: bezel, black glass, a dim iris ring and a pupil that follows the gaze. */
function eye(ctx: RecipeContext, center: Vec, dir: Vec, r: number, gain = 1): void {
  const fb = ctx.own;
  const d = dir.clone().normalize();
  fb.add('mech', collar(r * 0.95, r * 1.35, -0.012, 0.004, 24), alongZ(center, d), { edgeMin: 0.2 });
  fb.add('lens', cylinder(r, -0.012, -0.002, 24), alongZ(center, d));
  fb.add('glow', collar(r * 0.66, r * 0.84, -0.003, 0.0012, 24), alongZ(center, d));
  pupil(ctx, center.clone().addScaledVector(d, -0.002), d, r * 0.84, { size: 0.5, gain });
}

const LENS_DEPTH_M = 0.02;
const GLOW_DEPTH_M = 0.006;
const GLOW_PROUD_M = 0.0015; // how far the optic strip stands in front of the lens

/**
 * Dark lens band at x = `x` (its centre) with a dim glowing strip on its front face and a bright
 * hotspot that sweeps along the strip with the gaze.
 */
function visorBand(ctx: RecipeContext, x: number, z: number, lensW: number, lensH: number, glowW: number, glowH: number): void {
  ctx.own.add('lens', box(LENS_DEPTH_M, lensW, lensH, { bevel: 0.003, round: true, cell: 1 }), new THREE.Matrix4().makeTranslation(x, 0, z));
  const front = x + LENS_DEPTH_M / 2;
  ctx.own.add('glow', box(GLOW_DEPTH_M, glowW, glowH, { bevel: 0.002, cell: 1 }), new THREE.Matrix4().makeTranslation(front - GLOW_DEPTH_M / 2 + GLOW_PROUD_M, 0, z));
  const face = front + GLOW_PROUD_M;
  const half = glowW * 0.48;
  slider(ctx, V(face, -half, z), V(face, half, z), V(1, 0, 0), { length: glowW * 0.2, width: glowH * 1.35, depth: 0.004 });
}

function antenna(ctx: RecipeContext, base: Vec, len: number): void {
  ctx.own.add('mech', cylinder(0.009, 0, 0.018, 12), alongZ(base, V(0, 0, 1)));
  ctx.own.add('chrome', cylinder(0.0025, 0.012, len, 8, 0.001), alongZ(base, V(-0.12, 0, 1)));
}

// ---------------------------------------------------------------- variants

/** Bruiser: faceted armored box, brow plate, glowing slit, grille jaw, ear pods. */
export function headSlit(ctx: RecipeContext): void {
  const b = headBox(ctx);
  neck(ctx, b);
  const { hx, hy, h } = b;
  const fb = ctx.own;
  const outline: Array<[number, number]> = [
    [hx * 0.92, -hy * 0.55], [hx * 0.92, hy * 0.55], [hx * 0.55, hy * 0.9], [-hx * 0.75, hy * 0.9],
    [-hx * 0.92, hy * 0.6], [-hx * 0.92, -hy * 0.6], [-hx * 0.75, -hy * 0.9], [hx * 0.55, -hy * 0.9],
  ];
  fb.add('paint', polyPrism(outline, b.base + 0.02, b.base + h * 0.96, { bevel: 0.012, taper: 0.86, cell: 0.03 }), undefined, { cavity: 0.1 });
  facePlate(ctx, fb, V(hx * 0.84, 0, b.base + h * 0.76), V(1, 0, 0.75), h * 0.24, hy * 1.7, { bolts: 'edges', thick: ctx.style.plate * 0.9 });
  // Visor slit: dark lens band with the glowing optic strip standing just proud of it.
  visorBand(ctx, hx * 0.9, b.base + h * 0.585, hy * 1.5, h * 0.11, hy * 1.32, h * 0.05);
  facePlate(ctx, fb, V(hx * 0.86, 0, b.base + h * 0.3), V(1, 0, -0.3), h * 0.34, hy * 1.4, { bolts: 'corners', taper: 0.8 });
  grille(fb, V(hx * 0.9 + ctx.style.plate + 0.004, 0, b.base + h * 0.28), V(0, 1, 0), V(1, 0, -0.3), hy * 1.0, h * 0.2, 4, 0.014);
  for (const s of [-1, 1]) {
    facePlate(ctx, fb, V(hx * 0.1, s * hy * 0.84, b.base + h * 0.42), V(0, s, 0.1), h * 0.44, hx * 1.1, { accent: 'head.cheek', bolts: 'corners', thick: ctx.style.plate * 0.8 });
    fb.add('mech', drum(h * 0.13, 0.02, { segs: 26, plainBottom: true }), alongZ(V(-hx * 0.2, s * (hy * 0.86 + ctx.style.plate + 0.004), b.base + h * 0.6), V(0, s, 0)));
  }
  antenna(ctx, V(-hx * 0.55, hy * 0.45, b.base + h * 0.93), h * 0.45);
}

/** Striker: smooth tapered helmet, twin cyan optics, ear discs with light rings. */
export function headTwin(ctx: RecipeContext): void {
  const b = headBox(ctx);
  neck(ctx, b);
  const { hx, hy, h } = b;
  const fb = ctx.own;
  fb.add('paint', box(hx * 1.8, hy * 1.74, h * 0.7, { bevel: 0.035, round: true, cell: 0.03, taper: 0.9 }), new THREE.Matrix4().makeTranslation(-hx * 0.1, 0, b.base + h * 0.6), { cavity: 0.1 });
  facePlate(ctx, fb, V(hx * 0.74, 0, b.base + h * 0.46), V(1, 0, -0.12), h * 0.56, hy * 1.45, { taper: 0.62, bolts: 'none' });
  for (const s of [-1, 1]) eye(ctx, V(hx * 0.83 + ctx.style.plate, s * hy * 0.34, b.base + h * 0.6), V(1, s * 0.12, 0.05), h * 0.07);
  block(fb, 'frame', V(hx * 0.45, 0, b.base + h * 0.16), V(1, 0, 0), V(0, 1, 0), [hx * 0.8, hy * 0.9, h * 0.16], { cavity: 0.4 }, true);
  for (const s of [-1, 1]) {
    const c = V(-hx * 0.05, s * (hy * 0.87 + 0.004), b.base + h * 0.56);
    fb.add('mech', drum(h * 0.15, 0.022, { segs: 30, plainBottom: true }), alongZ(c, V(0, s, 0)));
    fb.add('glow', collar(h * 0.1, h * 0.115, 0.009, 0.013, 32), alongZ(c, V(0, s, 0)));
  }
  for (let i = 0; i < 4; i++) {
    const y = (i - 1.5) * 0.018;
    fb.add('rubber', cylinder(0.005, b.base - 0.004, b.base + h * 0.2, 6, 0.001), new THREE.Matrix4().makeTranslation(-hx * 0.35, y, 0), { color: i === 1 ? ctx.style.signal : ctx.style.cable });
  }
}

/** Goliath: riveted dome, heavy brow ring, one big optic and a small secondary. */
export function headDome(ctx: RecipeContext): void {
  const b = headBox(ctx);
  neck(ctx, b);
  const { hx, hy, h } = b;
  const fb = ctx.own;
  const R = Math.min(hx, hy) * 0.98;
  const z = (f: number) => b.base + h * f;
  fb.add('paint', lathe([
    [0, z(0.04), 1], [R * 0.88, z(0.04), 1], [R, z(0.1), 1], [R, z(0.45), 0], [R * 0.97, z(0.6), 0],
    [R * 0.88, z(0.74), 0], [R * 0.7, z(0.86), 0], [R * 0.42, z(0.94), 0], [0, z(0.97), 0],
  ], 44), new THREE.Matrix4().makeScale(hx / R, 1, 1), { cavity: 0.1 });
  fb.add('lens', shell(R * 0.98, R * 1.03, -1.0, 1.0, z(0.44), z(0.62), { arcSegs: 18 }), new THREE.Matrix4().makeScale(hx / R, 1, 1));
  fb.add('paint', collar(R * 0.98, R * 1.08, z(0.62), z(0.69), 44), new THREE.Matrix4().makeScale(hx / R, 1, 1), { accent: ctx.style.accents.has('head.brow'), edgeMin: 0.1 });
  eye(ctx, V(hx * 1.02, -hy * 0.22, z(0.53)), V(1, -0.2, 0), h * 0.085);
  eye(ctx, V(hx * 0.98, hy * 0.36, z(0.54)), V(1, 0.35, 0), h * 0.04, 0.8);
  fb.add('mech', collar(R * 0.78, R * 1.03, z(0.0), z(0.06), 40), undefined, { cavity: 0.3 });
  const rivets = 16;
  for (let i = 0; i < rivets; i++) {
    const a = (i / rivets) * Math.PI * 2;
    const n = V(Math.cos(a), Math.sin(a), 0);
    fb.bolt(V(Math.cos(a) * R * 1.035 * (hx / R), Math.sin(a) * R * 1.035, z(0.03)), n, ctx.style.boltSize * 0.9, 'rivet');
    fb.bolt(V(Math.cos(a) * R * 1.07 * (hx / R), Math.sin(a) * R * 1.07, z(0.655)), n, ctx.style.boltSize * 0.8, 'rivet');
  }
  for (const s of [-1, 1]) {
    fb.add('mech', drum(h * 0.1, 0.03, { segs: 24, plainBottom: true }), alongZ(V(-hx * 0.15, s * (R * 0.98 + 0.012), z(0.4)), V(0, s, 0)));
    antenna(ctx, V(-hx * 0.55, s * hy * 0.35, z(0.84)), h * 0.35);
  }
}

/** Generic helmet with a wide visor band (for designs that ask for head.visor). */
export function headVisor(ctx: RecipeContext): void {
  const b = headBox(ctx);
  neck(ctx, b);
  const { hx, hy, h } = b;
  const fb = ctx.own;
  fb.add('paint', box(hx * 1.84, hy * 1.8, h * 0.9, { bevel: 0.03, round: ctx.style.round, cell: 0.03, taper: 0.88 }), new THREE.Matrix4().makeTranslation(-hx * 0.04, 0, b.base + h * 0.5), { cavity: 0.1 });
  visorBand(ctx, hx * 0.88, b.base + h * 0.6, hy * 1.6, h * 0.22, hy * 1.4, h * 0.06);
  for (const s of [-1, 1]) fb.add('mech', drum(h * 0.12, 0.022, { segs: 24, plainBottom: true }), alongZ(V(0, s * hy * 0.92, b.base + h * 0.55), V(0, s, 0)));
}
