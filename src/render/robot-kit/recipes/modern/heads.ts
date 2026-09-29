// Heads of the modern electric fighters. Each is one moulded shell (plus fight gear) sized to the
// head's collision box; the neck-yaw stator sits in frame 0 on the torso, so a knocked-off head
// flies away whole and leaves the actuator socket behind.
//   head.trio   FIRECRACKER: squat graphite face, three warm lenses in a downward triangle, red
//               open-face padded headgear (crown, side wrap, cheek pads, brow roll, ear rings).
//   head.wedge  SAVATE: forward-raked aubergine wedge, one vertical mint light bar, cheek sensors.
//   head.hammer HAYMAKER: low wide flat-topped hammerhead, brow ledge, far-set red lenses, chin bar.
//   head.lozenge PYLON: slim upright lozenge canted forward, one big violet lens, two small, antenna
//               with a violet tip beacon.
// Every optic's bright part (pupils, the bar hotspot, the beacon) is a moving object (optics.ts)
// that eyes.ts drives from the gaze and the fighter's state.
import * as THREE from 'three/webgpu';
import type { FrameBuilder } from '../../geom/part-builder';
import { collar, cylinder, lathe, shell, tube } from '../../geom/prims';
import { alongZ } from '../../geom/xf';
import type { MatSlot } from '../../types';
import type { RecipeContext } from '../context';
import { block, grille, slab, V, type Vec } from '../mech';
import { beacon, barSlider, pupil } from '../optics';
import { band, joint } from './kit';
import { body, capsuleT, keys, loft, type Ring } from './shapes';

interface HeadBox {
  hx: number;
  hy: number;
  h: number;
  base: number;
}

function headBox(ctx: RecipeContext): HeadBox {
  const d = ctx.dims;
  return { hx: d.size.x / 2, hy: d.size.y / 2, h: d.size.z, base: d.min.z };
}

/** Neck: the yaw actuator on the torso (frame 0) and a short post into the head. */
function neck(ctx: RecipeContext, b: HeadBox, postR: number, postTop: number, slot: MatSlot = 'frame'): void {
  const f0 = ctx.frames[0];
  const R = Math.max(0.026, postR * 1.55);
  if (f0 && ctx.frames.length > 1) joint(ctx, f0, V(0, 0, 1), V(0, 0, -0.012), R, 0.02);
  ctx.own.add(slot, cylinder(postR, -0.004, b.base + postTop, 24, postR * 0.2), undefined, { cavity: 0.4 });
}

/**
 * Round optic: bezel ring, black glass, a dim iris ring and a bright pupil that moves across the
 * glass toward the gaze (optics.ts); `dir` is the look direction.
 */
function optic(ctx: RecipeContext, center: Vec, dir: Vec, r: number, bezel: MatSlot = 'mech', iris = 0.62, rim = 1.34, gain = 1): void {
  const fb = ctx.own;
  const d = dir.clone().normalize();
  const m = alongZ(center, d);
  fb.add(bezel, collar(r * 0.98, r * rim, -0.01, 0.003, 28), m, { edgeMin: 0.25 });
  fb.add('lens', cylinder(r, -0.01, 0.0005, 28, r * 0.08), m);
  fb.add('glow', collar(r * iris * 0.76, r * iris, -0.001, 0.0016, 24), m);
  pupil(ctx, center.clone().addScaledVector(d, 0.0005), d, r * 0.9, { size: Math.min(0.5, iris * 0.66), gain });
}

/** x of a superellipse section's surface at lateral offset y (the front face of a loft ring). */
function frontX(ring: { rx: number; ry: number; ox?: number }, y: number, p: number): number {
  const q = Math.min(0.999, Math.abs(y) / ring.ry);
  return (ring.ox ?? 0) + ring.rx * (1 - q ** p) ** (1 / p);
}

// ---------------------------------------------------------------- FIRECRACKER

export function headTrio(ctx: RecipeContext): void {
  const b = headBox(ctx);
  const { hx, hy, h, base } = b;
  const fb = ctx.own;
  const z = (f: number) => base + h * f;
  neck(ctx, b, Math.min(hx, hy) * 0.3, h * 0.14);
  // Squat rounded-trapezoid head core in graphite: wider at the jaw than the brow.
  const P = 3.2;
  const core = (t: number) => ({ rx: hx * keys(t, [[0, 0.7], [0.5, 0.8], [1, 0.74]]), ry: hy * keys(t, [[0, 0.8], [0.45, 0.78], [1, 0.62]]), ox: hx * 0.04 });
  fb.add('frame', body(z(0.1), z(0.9), 16, (t) => {
    const c = core(t);
    const env = capsuleT(t, 5);
    return { rx: c.rx * env, ry: c.ry * env, ox: c.ox };
  }, { segs: 36, power: P }), undefined, { cavity: 0.15 });
  // Three warm lenses in a downward triangle: two at the brow, one centred at mouth level.
  const lr = hy * 0.19;
  const tOf = (f: number) => (f - 0.1) / 0.8;
  for (const [yf, zf] of [[0.37, 0.57], [-0.37, 0.57], [0, 0.33]] as const) {
    const ring = core(tOf(zf));
    const y = yf * ring.ry;
    const x = frontX(ring, y, P);
    optic(ctx, V(x - 0.002, y, z(zf)), V(1, yf * 0.35, 0.02), lr, 'mech', 0.7);
  }
  // Short louvered chin vent.
  const chin = core(tOf(0.18));
  grille(fb, V(frontX(chin, 0, P) + 0.001, 0, z(0.18)), V(0, 1, 0), V(1, 0, -0.35), hy * 0.56, h * 0.075, 3, 0.006, 'mech');
  headgear(ctx, b);
}

/** Open-face padded headgear in the glove colour. */
function headgear(ctx: RecipeContext, b: HeadBox): void {
  const { hx, hy, h, base } = b;
  const fb = ctx.own;
  const z = (f: number) => base + h * f;
  const ex = hx * 1.12; // outer half-depth of the gear
  const ey = hy * 1.16; // outer half-width
  const pad = Math.min(hx, hy) * 0.3; // padding thickness
  // Crown: a padded dome from the brow line up over the top.
  fb.add('glove', body(z(0.7), z(1.07), 14, (t) => {
    const env = Math.max(0, 1 - t ** 2.2) ** 0.5; // flush with the wrap at the brow line
    return { rx: ex * env, ry: ey * env, ox: -hx * 0.04 };
  }, { segs: 40, power: 2.3 }), undefined, { cavity: 0.1 });
  // Side and back wrap: a thick arc from one cheek round the back to the other, open at the face.
  const open = 0.95; // radians either side of +x left open for the face
  const wrap = shell(ex - pad * 0.9, ex, open, Math.PI * 2 - open, z(0.2), z(0.76), { arcSegs: 26, zSegs: 6, bevel: pad * 0.35 });
  fb.add('glove', wrap, new THREE.Matrix4().makeScale(1, ey / ex, 1).setPosition(-hx * 0.04, 0, 0), { cavity: 0.1 });
  // Cheek pads: thick rounded rolls down the front edges of the wrap.
  for (const s of [-1, 1]) {
    const a = s * open;
    const c = V(Math.cos(a) * ex * 0.92 - hx * 0.02, Math.sin(a) * ey * 0.9, 0);
    fb.add('glove', body(z(0.2), z(0.66), 10, (t) => {
      const env = capsuleT(t, 3);
      return { rx: pad * 0.62 * env, ry: pad * 0.55 * env, ox: c.x, oy: c.y };
    }, { segs: 20 }), undefined, { cavity: 0.15 });
  }
  // Brow roll: a padded bar across the forehead above the lenses, capped with round ends.
  const pts: Vec[] = [];
  const nB = 9;
  for (let k = 0; k < nB; k++) {
    const a = -open * 1.05 + (2 * open * 1.05 * k) / (nB - 1);
    pts.push(V(Math.cos(a) * ex * 0.99 - hx * 0.04, Math.sin(a) * ey * 0.99, z(0.735) + Math.cos(a * 1.4) * h * 0.012));
  }
  const rollR = pad * 0.58;
  fb.add('glove', tube(pts, rollR, 12, 6), undefined, { cavity: 0.2 });
  for (const p of [pts[0], pts[pts.length - 1]]) fb.add('glove', sphere(rollR * 0.98), new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
  // Ear rings and a crown seam.
  for (const s of [-1, 1]) {
    const m = alongZ(V(-hx * 0.12, s * ey * 0.98, z(0.44)), V(0, s, 0));
    fb.add('glove', collar(h * 0.07, h * 0.15, -0.006, 0.006, 32), m, { cavity: 0.1 });
    fb.add('frame', cylinder(h * 0.075, -0.008, 0.001, 24), m, { cavity: 0.6 });
  }
  // Crown seam from the brow roll over the top to the back.
  const seam: Vec[] = [];
  for (let k = 0; k <= 10; k++) {
    const a = 0.35 + ((Math.PI - 0.7) * k) / 10;
    seam.push(V(Math.cos(a) * ex * 0.99 - hx * 0.04, 0, z(0.6) + Math.sin(a) * h * 0.455));
  }
  fb.add('glove', tube(seam, h * 0.011, 6, 4), undefined, { cavity: 0.4 });
  // Chin strap under the jaw.
  const strap: Vec[] = [];
  for (let k = 0; k <= 6; k++) {
    const a = -1 + (2 * k) / 6;
    strap.push(V(hx * 0.18 + Math.cos(a * 1.2) * hx * 0.26, Math.sin(a * 1.2) * ey * 0.86, z(0.2) - Math.cos(a * 1.4) * h * 0.08));
  }
  fb.add('rubber', tube(strap, h * 0.012, 6, 4), undefined, { color: '#141414' });
}

function sphere(r: number, segs = 16): THREE.BufferGeometry {
  const pairs: Array<[number, number, (0 | 1)?]> = [];
  for (let k = 0; k <= 8; k++) {
    const a = -Math.PI / 2 + (k / 8) * Math.PI;
    pairs.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  return lathe(pairs, segs);
}

// ---------------------------------------------------------------- SAVATE

export function headWedge(ctx: RecipeContext): void {
  const b = headBox(ctx);
  const { hx, hy, h, base } = b;
  const fb = ctx.own;
  const z = (f: number) => base + h * f;
  neck(ctx, b, Math.min(hx, hy) * 0.26, h * 0.3, 'mech');
  band(fb, z(0.1), Math.min(hx, hy) * 0.26, Math.min(hx, hy) * 0.33, h * 0.05, 'frame');
  // Forward-raked wedge: the face leans back from a high brow prow to a set-back chin, and the
  // crown slopes down from the prow to the back.
  const P = 3.0;
  const rings: Ring[] = [
    { z: z(0.13), rx: hx * 0.34, ry: hy * 0.34, ox: -hx * 0.16 },
    { z: z(0.2), rx: hx * 0.48, ry: hy * 0.46, ox: -hx * 0.13 },
    { z: z(0.34), rx: hx * 0.64, ry: hy * 0.58, ox: -hx * 0.08 },
    { z: z(0.52), rx: hx * 0.78, ry: hy * 0.68, ox: -hx * 0.02 },
    { z: z(0.7), rx: hx * 0.88, ry: hy * 0.73, ox: hx * 0.06 },
    { z: z(0.82), rx: hx * 0.92, ry: hy * 0.72, ox: hx * 0.16, hard: true },
    { z: z(0.9), rx: hx * 0.8, ry: hy * 0.64, ox: hx * 0.32 },
    { z: z(0.96), rx: hx * 0.52, ry: hy * 0.52, ox: hx * 0.6 },
    { z: z(0.995), rx: hx * 0.2, ry: hy * 0.34, ox: hx * 0.9 },
  ];

  fb.add('paint', loft(rings, { segs: 40, power: P }), undefined, { cavity: 0.1 });
  // One pale-mint light bar down the centreline, brow to chin, in a dark groove.
  const bar: Vec[] = [];
  for (const r of rings.slice(1, 7)) bar.push(V(frontX(r, 0, P) + 0.0005, 0, r.z));
  fb.add('lens', tube(bar, h * 0.018, 8, 6), undefined, {});
  fb.add('glow', tube(bar.map((p) => p.clone().add(V(h * 0.012, 0, 0))), h * 0.008, 8, 6));
  // A brighter hotspot rides the bar: it tracks the gaze up and down and sweeps it when scanning.
  barSlider(ctx, bar.map((p) => p.clone().add(V(h * 0.02, 0, 0))), h * 0.0135, { along: 3, gain: 1.25 });
  // Cheek sensors in brushed-aluminium bezels, low on each side.
  for (const s of [-1, 1]) {
    const r = rings[2];
    const c = V(r.ox ?? 0, s * r.ry * 0.98, r.z + h * 0.02);
    optic(ctx, c, V(0.15, s, 0), h * 0.045, 'frame', 0.3, 1.34, 0.7);
  }
  // A shallow seam where the face shell meets the crown.
  const seam: Vec[] = [];
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const r = rings[5];
    seam.push(V((r.ox ?? 0) + Math.cos(a) * r.rx * 1.004, Math.sin(a) * r.ry * 1.004, r.z - h * 0.02));
  }
  fb.add('frame', tube(seam, h * 0.0045, 5, 4), undefined, { cavity: 0.8 });
}

// ---------------------------------------------------------------- HAYMAKER

export function headHammer(ctx: RecipeContext): void {
  const b = headBox(ctx);
  const { hx, hy, h, base } = b;
  const fb = ctx.own;
  const z = (f: number) => base + h * f;
  // Sunk low between the shoulder cowls: the block starts just below the neck joint.
  neck(ctx, b, Math.min(hx, hy) * 0.34, h * 0.02, 'mech');
  // Face block: solid, narrower than the hammer, with a recessed band above the chin bar.
  slabBox(ctx, fb, 'paint', V(hx * 0.04, 0, z(0.21)), [hx * 1.34, hy * 1.5, h * 0.66]);
  slabBox(ctx, fb, 'frame', V(hx * 0.52, 0, z(0.17)), [hx * 0.4, hy * 1.3, h * 0.07]);
  // Heavy chin bar across the front.
  slabBox(ctx, fb, 'paint', V(hx * 0.54, 0, z(0.03)), [hx * 0.5, hy * 1.56, h * 0.19], true);
  // The hammer: a low, wide, flat-topped slab overhanging the face as a thick brow ledge.
  slab(fb, ctx.style, { center: V(hx * 0.1, 0, z(0.6)), u: V(1, 0, 0), v: V(0, 1, 0), lenU: hx * 1.66, lenV: hy * 2.54, thick: h * 0.24, bolts: 'none', round: false, bevel: h * 0.05 });
  // Wings: the slab's outer ends drop a little lower, carrying the lenses.
  for (const s of [-1, 1]) slabBox(ctx, fb, 'paint', V(hx * 0.36, s * hy * 1.02, z(0.45)), [hx * 0.86, hy * 0.46, h * 0.12]);
  // Two small red-orange lenses at the far outer corners, under the ledge.
  for (const s of [-1, 1]) optic(ctx, V(hx * 0.8, s * hy * 1.04, z(0.45)), V(1, s * 0.15, -0.05), h * 0.042, 'mech', 0.6);
  // Button-head bolts on the hammer and down the face.
  const rb = ctx.style.boltSize;
  for (const x of [-0.55, 0.65]) for (const y of [-1.0, -0.35, 0.35, 1.0]) fb.bolt(V(hx * x, hy * y, z(0.6) + h * 0.12), V(0, 0, 1), rb, 'rivet');
  for (const y of [-0.72, 0.72]) fb.bolt(V(hx * 0.79, hy * y, z(0.03)), V(1, 0, 0), rb, 'rivet');
  for (const s of [-1, 1]) for (const x of [-0.3, 0.4]) fb.bolt(V(hx * x, s * hy * 0.75, z(0.28)), V(0, s, 0), rb, 'rivet');
}

/** Chamfered solid block (thick UHMW-like slab) centred at `c` with sizes x, y, z. */
function slabBox(ctx: RecipeContext, fb: FrameBuilder, slot: MatSlot, c: Vec, size: [number, number, number], round = false): void {
  block(fb, slot, c, V(1, 0, 0), V(0, 1, 0), size, { cavity: slot === 'frame' ? 0.6 : 0.1 }, round || ctx.style.round);
}

// ---------------------------------------------------------------- PYLON

export function headLozenge(ctx: RecipeContext): void {
  const b = headBox(ctx);
  const { hx, hy, h, base } = b;
  const fb = ctx.own;
  const z = (f: number) => base + h * f;
  const postR = Math.min(hx, hy) * 0.22;
  neck(ctx, b, postR, h * 0.3, 'frame');
  band(fb, z(0.06), postR, postR * 1.3, h * 0.05);
  // Slim upright lozenge, canted forward: narrow chin, widest above the middle, round crown.
  const P = 2.25;
  const sec = (t: number) => ({
    rx: hx * keys(t, [[0, 0.5], [0.35, 0.84], [0.62, 0.92], [1, 0.86]]),
    ry: hy * keys(t, [[0, 0.4], [0.35, 0.66], [0.62, 0.76], [1, 0.7]]),
    ox: hx * (-0.1 + 0.24 * t),
  });
  const z0 = 0.16;
  const z1 = 1.04;
  fb.add('paint', body(z(z0), z(z1), 18, (t) => {
    const s = sec(t);
    const env = capsuleT(t, 2.4);
    return { rx: s.rx * env, ry: s.ry * env, ox: s.ox };
  }, { segs: 40, power: P }), undefined, { cavity: 0.1 });
  const at = (zf: number) => {
    const t = (zf - z0) / (z1 - z0);
    const s = sec(t);
    const env = capsuleT(t, 2.4);
    return { rx: s.rx * env, ry: s.ry * env, ox: s.ox };
  };
  // One large violet lens offset to the robot's right, two small stacked on its left. Each sits
  // along the local surface normal so it seats flush on the curved shell.
  const seat = (zf: number, yk: number, r: number, iris: number) => {
    const sec = at(zf);
    const y = sec.ry * yk;
    const dz = 0.02;
    const slope = (frontX(at(zf + dz), at(zf + dz).ry * yk, P) - frontX(at(zf - dz), at(zf - dz).ry * yk, P)) / (2 * dz * h);
    const n = V(1, (yk * 1.1 * sec.rx) / sec.ry, -slope).normalize();
    optic(ctx, V(frontX(sec, y, P), y, z(zf)).addScaledVector(n, 0.0015), n, r, 'frame', iris, 1.14);
  };
  const big = at(0.64);
  seat(0.64, -0.3, big.ry * 0.34, 0.8);
  for (const zf of [0.73, 0.6]) seat(zf, 0.4, at(zf).ry * 0.15, 0.78);
  // Antenna stub at the right rear (the small-lens side).
  const top = at(0.86);
  const baseP = V((top.ox ?? 0) - top.rx * 0.45, top.ry * 0.62, z(0.86));
  fb.add('mech', cylinder(h * 0.035, -0.004, h * 0.05, 14), alongZ(baseP, V(-0.2, 0.25, 1)));
  const mast = V(-0.22, 0.25, 1).normalize();
  fb.add('chrome', cylinder(h * 0.009, h * 0.03, h * 0.32, 8, 0.001), alongZ(baseP, mast));
  // Violet tip light: pulses with aggression, burns steady on a lock-on.
  beacon(ctx, baseP.clone().addScaledVector(mast, h * 0.32 + h * 0.012), h * 0.017, 0.9);
  // A fine parting line around the face.
  const seam: Vec[] = [];
  const ringZ = 0.42;
  const r = at(ringZ);
  for (let k = 0; k <= 12; k++) {
    const a = -Math.PI / 2 + (k / 12) * Math.PI;
    const p = superProfilePoint(a, P);
    seam.push(V((r.ox ?? 0) + p[0] * r.rx * 1.004, p[1] * r.ry * 1.004, z(ringZ) + Math.cos(a) * h * 0.02));
  }
  fb.add('frame', tube(seam, h * 0.004, 5, 4), undefined, { cavity: 0.8 });
}

function superProfilePoint(a: number, p: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [Math.sign(c) * Math.abs(c) ** e, Math.sign(s) * Math.abs(s) ** e];
}
