// Torsos and pelvises of the modern electric fighters.
//   torso.pebble  FIRECRACKER: gloss egg chest widest at the top, hex graphite belly plate, a warm
//                 glowing chevron on the sternum, a narrow graphite waist drum.
//   torso.diamond SAVATE: faceted kite plate pointing down to a narrow ribbed waist, raised centre
//                 ridge, separate side plates.
//   torso.cowl    HAYMAKER: barrel chest of thick bolted slab panels over a black frame, exposed
//                 waist drums and struts, short belly plate. (The shoulder cowls ride the arms.)
//   torso.slim    PYLON: narrow tall shield chest over an exposed segmented spine.
// The waist yaw / pitch stators sit in the torso's joint frames on the pelvis, as in torso.chest.
import * as THREE from 'three/webgpu';
import { collar, cylinder, polyPrism } from '../../geom/prims';
import { housingRadius, type RecipeContext } from '../context';
import { numberDecal, partPos } from '../common';
import { block, grille, slab, V } from '../mech';
import { facePlate } from '../torso';
import { band, joint, ribbedSleeve } from './kit';
import { body, capsuleT, frame, keys } from './shapes';

interface TorsoBox {
  hx: number;
  hy: number;
  z0: number;
  z1: number;
  H: number;
}

function torsoBox(ctx: RecipeContext): TorsoBox {
  const d = ctx.dims;
  return { hx: d.size.x / 2, hy: d.size.y / 2, z0: d.min.z, z1: d.max.z, H: d.size.z };
}

/** Waist yaw bearing on the pelvis, pitch drums on the yaw frame, and a spine column up to the chest. */
function waist(ctx: RecipeContext, t: TorsoBox, spineTop: number, spineR: number): void {
  const pelvis = ctx.parentDims;
  const R = Math.min(t.hx, pelvis ? pelvis.size.y / 2 : t.hy) * 0.74;
  const [yawF, pitchF] = ctx.frames;
  if (yawF && ctx.frames.length > 1) joint(ctx, yawF, V(0, 0, 1), V(0, 0, -0.004), R, 0.03);
  if (pitchF && ctx.frames.length > 2) {
    const Rp = housingRadius(ctx.part, 1) * 0.85;
    for (const s of [-1, 1]) joint(ctx, pitchF, V(0, s, 0), V(0, s * spineR * 1.25, 0.03), Rp, Rp * 0.8);
  }
  ribbedSleeve(ctx.own, spineTop, 0.012, spineR, spineR * 1.08, Math.max(2, Math.round((spineTop - 0.012) / 0.03)), 'mech');
}

/** Collar around the neck post and small shoulder bosses. */
function neckAndShoulders(ctx: RecipeContext, t: TorsoBox, slot: 'frame' | 'mech' | 'paint', neckR: number): void {
  const neck = partPos(ctx, 'head');
  if (neck) ctx.own.add(slot, collar(neckR * 0.7, neckR * 1.25, t.z1 - 0.03, neck.z + 0.004, 36), new THREE.Matrix4().makeTranslation(neck.x, neck.y, 0), { cavity: 0.3 });
  for (const id of ['upperarm_l', 'upperarm_r']) {
    const p = partPos(ctx, id);
    const arm = ctx.design.parts.find((q) => q.id === id);
    if (!p || !arm) continue;
    const s = Math.sign(p.y) || 1;
    const R = housingRadius(arm, 0) * 1.1;
    ctx.own.add('frame', cylinder(R, t.hy * 0.7, t.hy + 0.004, 32, 0.004), frame(V(1, 0, 0), V(0, 0, 1).multiplyScalar(-s), V(0, s, 0), V(p.x, 0, p.z)), { cavity: 0.4 });
  }
}

/** Front-surface x of a body section at lateral offset y. */
function surfX(sec: { rx: number; ry: number; ox?: number }, y: number, p: number): number {
  const q = Math.min(0.999, Math.abs(y) / sec.ry);
  return (sec.ox ?? 0) + sec.rx * (1 - q ** p) ** (1 / p);
}

// ---------------------------------------------------------------- FIRECRACKER

export function torsoPebble(ctx: RecipeContext): void {
  const t = torsoBox(ctx);
  const { hx, hy, z0, z1, H } = t;
  const fb = ctx.own;
  waist(ctx, t, z0 + H * 0.36, Math.min(hx, hy) * 0.44);
  // Egg chest: widest near the top, rounding over the shoulders, no flat front.
  const P = 2.2;
  const ca = z0 + H * 0.3;
  const cb = z1 + H * 0.03;
  const sec = (u: number) => ({
    rx: hx * keys(u, [[0, 0.66], [0.4, 0.9], [0.72, 1.0], [1, 0.96]]),
    ry: hy * keys(u, [[0, 0.58], [0.4, 0.84], [0.74, 0.98], [1, 0.92]]),
    ox: hx * 0.05,
  });
  const shape = (u: number) => {
    const s = sec(u);
    const env = keys(u, [[0, 0], [0.04, 0.55], [0.14, 0.9], [0.3, 1], [0.8, 1], [0.93, 0.86], [1, 0]]);
    const top = u > 0.8 ? Math.sqrt(Math.max(0, 1 - ((u - 0.8) / 0.2) ** 2.2)) : 1;
    return { rx: s.rx * env * Math.max(top, 0), ry: s.ry * env * Math.max(top, 0), ox: s.ox };
  };
  fb.add('paint', body(ca, cb, 26, shape, { segs: 48, power: P }), undefined, { cavity: 0.06, decal: numberDecal('x', [0.6, 0.52, 0.92, 0.74]) });
  // Hexagonal graphite belly plate under the egg.
  const hexW = hy * 0.44;
  const hexH = H * 0.09;
  const hex: Array<[number, number]> = [[hexW, 0], [hexW * 0.55, hexH], [-hexW * 0.55, hexH], [-hexW, 0], [-hexW * 0.55, -hexH], [hexW * 0.55, -hexH]];
  const hz = z0 + H * 0.26;
  const bellyX = hx * 0.48;
  fb.add('frame', polyPrism(hex, 0, hx * 0.3, { bevel: 0.006, cell: 0.03 }), frame(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0), V(bellyX, 0, hz)), { cavity: 0.2 });
  // Lower torso: a graphite core behind the plate, tucking into the waist drum.
  fb.add('frame', body(z0 - H * 0.02, z0 + H * 0.46, 12, (u) => {
    const env = capsuleT(u, 3);
    return { rx: hx * 0.66 * env, ry: hy * keys(u, [[0, 0.5], [1, 0.66]]) * env, ox: hx * 0.02 };
  }, { segs: 36, power: 2.4 }), undefined, { cavity: 0.4 });
  // Warm chevron on the sternum, set into a dark lens channel.
  const cu = 0.66;
  const cz = ca + (cb - ca) * cu;
  const s0 = shape(cu);
  const armL = hy * 0.3;
  for (const s of [-1, 1]) {
    const ang = s * 0.52;
    const y = s * armL * 0.44;
    const x = surfX(s0, y, P) - 0.002;
    const u = V(0, s * Math.cos(ang * s), Math.sin(ang * s)).normalize();
    const n = V(1, s * 0.25, 0).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    block(fb, 'lens', V(x, y, cz + armL * 0.2), u, v, [armL, H * 0.05, 0.008], {}, true);
    block(fb, 'glow', V(x + 0.003, y, cz + armL * 0.2), u, v, [armL * 0.92, H * 0.028, 0.006], {}, true);
  }
  // Back: a flush battery hatch and a vent.
  facePlate(ctx, fb, V(-hx * 0.86, 0, z0 + H * 0.62), V(-1, 0, 0.05), H * 0.34, hy * 0.9, { bolts: 'corners', thick: 0.006 });
  grille(fb, V(-hx * 0.92, 0, z0 + H * 0.4), V(0, 1, 0), V(-1, 0, 0), hy * 0.7, H * 0.08, 3, 0.01, 'frame');
  neckAndShoulders(ctx, t, 'frame', Math.min(hx, hy) * 0.24);
}

// ---------------------------------------------------------------- SAVATE

export function torsoDiamond(ctx: RecipeContext): void {
  const t = torsoBox(ctx);
  const { hx, hy, z0, z1, H } = t;
  const fb = ctx.own;
  waist(ctx, t, z0 + H * 0.45, Math.min(hx, hy) * 0.5);
  // Chest yoke behind the diamond: broad at the shoulders, tapering hard to the waist.
  fb.add('paint', body(z0 + H * 0.3, z1 + H * 0.02, 20, (u) => {
    const env = keys(u, [[0, 0], [0.05, 0.6], [0.15, 0.92], [0.3, 1], [0.84, 1], [0.95, 0.8], [1, 0]]);
    return { rx: hx * keys(u, [[0, 0.55], [0.6, 0.86], [1, 0.84]]) * env, ry: hy * keys(u, [[0, 0.46], [0.55, 0.86], [0.85, 0.96], [1, 0.9]]) * env, ox: -hx * 0.04 };
  }, { segs: 44, power: 2.8 }), undefined, { cavity: 0.1 });
  // Diamond (kite) plate: two facets meeting at a raised centre ridge, pointing down to the waist.
  const T = ctx.style.plate * 1.4;
  const zTop = z1 - H * 0.04;
  const zMid = z1 - H * 0.3;
  const zTip = z0 + H * 0.2;
  const zc = (zTip + zTop) / 2;
  const outline: Array<[number, number]> = [[0, zTip - zc], [hy * 0.9, zMid - zc], [hy * 0.8, zTop - zc], [0, zTop + H * 0.02 - zc]];
  const xRidge = hx * 1.08;
  const n = V(1, 0.32, 0.08).normalize();
  const vUp = V(0, 0, 1).addScaledVector(n, -n.z).normalize();
  const along = new THREE.Vector3().crossVectors(vUp, n);
  const place = frame(along, vUp, n, V(xRidge - T, 0, zc));
  for (const s of [1, -1]) {
    const geo = polyPrism(outline, 0, T, { bevel: T * 0.4, cell: 0.03 });
    const m = s < 0 ? new THREE.Matrix4().makeScale(1, -1, 1).multiply(place) : place.clone();
    fb.add('paint', geo, m, { cavity: 0.05, decal: s > 0 ? numberDecal('x', [0.3, 0.45, 0.85, 0.75]) : undefined });
  }
  // Raised ridge down the centre line.
  const ridge: Array<[number, number]> = [[-0.006, zTip + H * 0.04], [0.006, zTip + H * 0.04], [0.006, zTop], [-0.006, zTop]];
  fb.add('paint', polyPrism(ridge, 0, T * 0.9, { bevel: 0.003, cell: 0.03 }), frame(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0), V(xRidge + T * 0.2, 0, 0)), { edgeMin: 0.3 });
  // Side plates under the arms, and a tapered back plate.
  for (const s of [-1, 1]) facePlate(ctx, fb, V(-hx * 0.08, s * hy * 0.78, z0 + H * 0.64), V(0, s, 0.12), H * 0.36, hx * 1.2, { bolts: 'none', taper: 0.72, thick: ctx.style.plate });
  facePlate(ctx, fb, V(-hx * 0.8, 0, z0 + H * 0.66), V(-1, 0, 0.08), H * 0.46, hy * 1.2, { bolts: 'none', taper: 0.6, thick: ctx.style.plate });
  // Ribbed dark abdomen between the diamond point and the waist.
  ribbedSleeve(fb, z0 + H * 0.46, z0 - H * 0.02, hx * 0.6, hx * 0.52, 4, 'mech', V(hx * 0.1, 0, 0));
  neckAndShoulders(ctx, t, 'mech', Math.min(hx, hy) * 0.3);
  // Aluminium collar ring at the neck.
  const neck = partPos(ctx, 'head');
  if (neck) band(fb, t.z1 + 0.006, Math.min(hx, hy) * 0.3, Math.min(hx, hy) * 0.42, 0.012, 'frame', V(neck.x, neck.y, 0));
}

// ---------------------------------------------------------------- HAYMAKER

export function torsoCowl(ctx: RecipeContext): void {
  const t = torsoBox(ctx);
  const { hx, hy, z0, z1, H } = t;
  const fb = ctx.own;
  const T = ctx.style.plate * 1.1;
  waist(ctx, t, z0 + H * 0.3, Math.min(hx, hy) * 0.5);
  // Barrel core in olive UHMW, square-ish in section.
  fb.add('paint', body(z0 + H * 0.26, z1 - H * 0.01, 18, (u) => {
    const env = keys(u, [[0, 0], [0.06, 0.8], [0.18, 1], [0.86, 1], [0.97, 0.72], [1, 0]]);
    return { rx: hx * 0.86 * env, ry: hy * keys(u, [[0, 0.8], [0.5, 0.96], [1, 0.9]]) * env, ox: -hx * 0.04 };
  }, { segs: 40, power: 3.4 }), undefined, { cavity: 0.2 });
  // Two thick front panels split down the middle, bolted at the edges.
  for (const s of [-1, 1]) {
    slab(fb, ctx.style, {
      center: V(hx * 0.84, s * hy * 0.43, z0 + H * 0.66), u: V(0.08, 0, -1), v: V(0, 1, 0), lenU: H * 0.56, lenV: hy * 0.84, thick: T,
      bolts: 'edges', round: false, surf: { cavity: 0.1, decal: s > 0 ? numberDecal('x', [0.18, 0.3, 0.82, 0.62]) : undefined },
    });
  }
  // Flat bolted top plate round the neck.
  slab(fb, ctx.style, { center: V(-hx * 0.04, 0, z1 - T * 0.4), u: V(1, 0, 0), v: V(0, 1, 0), lenU: hx * 1.5, lenV: hy * 1.5, thick: T, bolts: 'corners', round: false });
  // Side panels and a big back plate with the stencil number.
  for (const s of [-1, 1]) facePlate(ctx, fb, V(-hx * 0.02, s * hy * 0.84, z0 + H * 0.6), V(0, s, 0), H * 0.5, hx * 1.3, { bolts: 'edges', thick: T });
  slab(fb, ctx.style, { center: V(-hx * 0.84, 0, z0 + H * 0.62), u: V(0, 0, -1), v: V(0, -1, 0), lenU: H * 0.56, lenV: hy * 1.5, thick: T, bolts: 'edges', round: false, surf: { decal: numberDecal('-x', [0.28, 0.25, 0.72, 0.7]) } });
  // Short belly plate over the waist frame.
  slab(fb, ctx.style, { center: V(hx * 0.74, 0, z0 + H * 0.2), u: V(0.15, 0, -1), v: V(0, 1, 0), lenU: H * 0.14, lenV: hy * 0.96, thick: T * 0.9, bolts: 'corners', round: false });
  // Black anodized frame: a belt ring and diagonal struts from the chest down to it.
  fb.add('frame', collar(Math.min(hx, hy) * 0.62, Math.min(hx, hy) * 0.84, z0 + H * 0.04, z0 + H * 0.12, 40), new THREE.Matrix4().makeScale(hx / Math.min(hx, hy), hy / Math.min(hx, hy), 1), { cavity: 0.3 });
  for (const s of [-1, 1]) {
    for (const x of [-0.5, 0.5]) {
      const a = V(hx * x, s * hy * 0.72, z0 + H * 0.3);
      const b = V(hx * x * 0.8, s * hy * 0.42, z0 + H * 0.08);
      const dir = b.clone().sub(a);
      const u = dir.clone().normalize();
      const side = V(1, 0, 0).addScaledVector(u, -u.x).normalize();
      block(fb, 'frame', a.clone().add(b).multiplyScalar(0.5), u, side, [dir.length(), 0.018, 0.018], { cavity: 0.4 });
    }
  }
  neckAndShoulders(ctx, t, 'paint', Math.min(hx, hy) * 0.42);
}

// ---------------------------------------------------------------- PYLON

export function torsoSlim(ctx: RecipeContext): void {
  const t = torsoBox(ctx);
  const { hx, hy, z0, z1, H } = t;
  const fb = ctx.own;
  const spineR = Math.min(hx, hy) * 0.42;
  waist(ctx, t, z0 + H * 0.44, spineR);
  // Narrow tall shield chest: flat-ish front, widest at the shoulders, tapering down.
  fb.add('paint', body(z0 + H * 0.36, z1 + H * 0.01, 20, (u) => {
    const env = keys(u, [[0, 0], [0.04, 0.7], [0.12, 0.96], [0.25, 1], [0.88, 1], [0.97, 0.78], [1, 0]]);
    return { rx: hx * keys(u, [[0, 0.6], [0.7, 0.84], [1, 0.8]]) * env, ry: hy * keys(u, [[0, 0.56], [0.65, 0.8], [0.9, 0.84], [1, 0.8]]) * env, ox: hx * 0.02 };
  }, { segs: 44, power: 3.1 }), undefined, { cavity: 0.08, decal: numberDecal('-x', [0.25, 0.35, 0.75, 0.72]) });
  // Silver band where the shield meets the spine, and a shoulder yoke.
  const bandZ = z0 + H * 0.39;
  fb.add('trim', collar(0, 1, bandZ - 0.008, bandZ + 0.008, 40), new THREE.Matrix4().makeScale(hx * 0.62, hy * 0.6, 1), { edgeMin: 0.2 });
  neckAndShoulders(ctx, t, 'frame', Math.min(hx, hy) * 0.26);
  const neck = partPos(ctx, 'head');
  if (neck) band(fb, t.z1 + 0.004, Math.min(hx, hy) * 0.26, Math.min(hx, hy) * 0.33, 0.01, 'trim', V(neck.x, neck.y, 0));
}

// ---------------------------------------------------------------- pelvis

/** Modern pelvis: a moulded brief (pebble / hivis), a split skirt (blade), a bolted plate (slab). */
export function pelvisModern(ctx: RecipeContext): void {
  const d = ctx.dims;
  const hx = d.size.x / 2;
  const hy = d.size.y / 2;
  const hz = d.size.z / 2;
  const fb = ctx.own;
  const limbs = ctx.style.limbs;
  // Structural core the hip actuators bolt to.
  const blade = limbs === 'blade';
  block(fb, blade ? 'mech' : 'frame', V(0, 0, 0), V(1, 0, 0), V(0, 1, 0), [hx * (blade ? 1.3 : 1.5), hy * (blade ? 1.2 : 1.4), hz * 1.6], { cavity: 0.5 }, true);
  if (limbs === 'pebble' || limbs === 'hivis') {
    // Brief: a rounded V cup, full width at the belt, narrowing to the crotch.
    const P = limbs === 'hivis' ? 2.7 : 2.2;
    fb.add('paint', body(-hz * 1.22, hz * 1.02, 16, (u) => {
      const env = capsuleT(u, 4);
      return { rx: hx * keys(u, [[0, 0.62], [0.5, 0.9], [1, 0.92]]) * env, ry: hy * keys(u, [[0, 0.32], [0.55, 0.78], [1, 0.96]]) * env, ox: hx * keys(u, [[0, 0.18], [1, 0.06]]) };
    }, { segs: 40, power: P }), undefined, { cavity: 0.08 });
    if (limbs === 'hivis') band(fb, hz * 0.9, hy * 0.6, hy * 0.66, 0.012, 'trim');
    else band(fb, hz * 0.96, Math.min(hx, hy) * 0.5, Math.min(hx, hy) * 0.8, 0.014, 'frame');
    return;
  }
  if (limbs === 'blade') {
    // Aluminium belt, a centre panel and two skirt panels angled out over the hips.
    fb.add('frame', collar(0, 1, hz * 0.62, hz * 0.98, 40), new THREE.Matrix4().makeScale(hx * 0.92, hy * 0.9, 1), { edgeMin: 0.2 });
    facePlate(ctx, fb, V(hx * 0.8, 0, -hz * 0.15), V(1, 0, -0.08), hz * 1.55, hy * 0.62, { bolts: 'none', taper: 0.62, thick: ctx.style.plate * 1.2 });
    for (const s of [-1, 1]) facePlate(ctx, fb, V(hx * 0.74, s * hy * 0.64, -hz * 0.05), V(1, s * 0.75, -0.12), hz * 1.4, hy * 0.6, { bolts: 'none', taper: 0.8, thick: ctx.style.plate * 1.2 });
    facePlate(ctx, fb, V(-hx * 0.8, 0, 0), V(-1, 0, -0.05), hz * 1.4, hy * 1.1, { bolts: 'none', thick: ctx.style.plate });
    return;
  }
  // slab: black belt, bolted olive crotch plate and back plate.
  fb.add('frame', collar(0, 1, hz * 0.55, hz * 0.98, 40), new THREE.Matrix4().makeScale(hx * 0.96, hy * 0.94, 1), { cavity: 0.3 });
  facePlate(ctx, fb, V(hx * 0.8, 0, -hz * 0.1), V(1, 0, -0.1), hz * 1.7, hy * 0.95, { bolts: 'corners', taper: 0.6, thick: ctx.style.plate });
  facePlate(ctx, fb, V(-hx * 0.8, 0, 0), V(-1, 0, 0), hz * 1.5, hy * 1.2, { bolts: 'corners', thick: ctx.style.plate });
}
