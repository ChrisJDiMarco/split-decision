// Fists of the modern fighters. The knuckle face is -z (it lands when the arm extends), the palm
// faces the body midline, the back of the hand faces out.
//   fist.glove    a padded boxing glove in the glove colour: bulbous mitt, thumb, laced cuff with
//                 a strap (white cuffs where the design asks for them). Dents and scuffs like armour.
//   fist.knuckle  a compact bare mechanical fist: back-of-hand plate, jointed fingers, raised
//                 knuckle plates (graphite on SAVATE, black rubber bumpers on PYLON).
import * as THREE from 'three/webgpu';
import { collar, cylinder, tube } from '../../geom/prims';
import { alongZ } from '../../geom/xf';
import type { MatSlot } from '../../types';
import type { RecipeContext } from '../context';
import { block, V, type Vec } from '../mech';
import { body, capsuleT, keys } from './shapes';

/** Glove geometry is sized from the striker sphere the physics uses (radius R). */
export function fistGlove(ctx: RecipeContext): void {
  const R = ctx.dims.size.x / 2;
  const s = ctx.side || 1;
  const fb = ctx.own;
  // Mitt: a round padded knuckle end, fattest over the fingers, narrowing into the cuff. The
  // finger roll bulges toward the palm; the back of the hand carries extra padding.
  const z0 = -1.06 * R;
  const z1 = 0.62 * R;
  fb.add('glove', body(z0, z1, 24, (t) => {
    const tip = t < 0.4 ? Math.sqrt(Math.max(0, 1 - ((0.4 - t) / 0.4) ** 2)) : 1;
    const top = t > 0.78 ? keys(t, [[0.78, 1], [0.92, 0.9], [1, 0]]) : 1;
    const w = keys(t, [[0, 1], [0.35, 1], [0.72, 0.84], [1, 0.72]]);
    const oy = keys(t, [[0, -0.06], [0.3, -0.08], [0.7, 0.04], [1, 0.05]]);
    return { rx: 0.88 * R * w * tip * top, ry: 0.8 * R * w * tip * top, oy: s * oy * R };
  }, { segs: 44, power: 2.1 }), undefined, { cavity: 0.08 });
  // Thumb: a padded sausage on the front of the palm side, stitched along the mitt.
  const tA = V(0.66 * R, -s * 0.36 * R, 0.36 * R);
  const tB = V(0.72 * R, -s * 0.46 * R, -0.46 * R);
  const len = tA.distanceTo(tB);
  const thumb = body(0, len, 12, (t) => {
    const env = capsuleT(t, 2.2);
    const w = keys(t, [[0, 0.84], [0.55, 1], [1, 0.9]]);
    return { rx: 0.31 * R * env * w, ry: 0.29 * R * env * w };
  }, { segs: 22 });
  fb.add('glove', thumb, alongZ(tB, tA.clone().sub(tB).normalize()), { cavity: 0.2 });
  // Seam lines: round the knuckle roll and down the palm.
  const seam: Vec[] = [];
  for (let k = 0; k <= 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    seam.push(V(Math.cos(a) * 0.83 * R, Math.sin(a) * 0.755 * R - s * 0.065 * R, -0.62 * R));
  }
  fb.add('glove', tube(seam, 0.022 * R, 5, 4), undefined, { cavity: 0.5 });
  // Cuff: a padded collar over the wrist with a strap band; white on designs that ask for it.
  const cuffSlot: MatSlot = ctx.look.cuff === 'trim' ? 'trim' : 'glove';
  fb.add(cuffSlot, body(0.34 * R, 1.26 * R, 10, (t) => {
    const env = capsuleT(t, 5);
    return { rx: 0.7 * R * env, ry: 0.64 * R * env, oy: s * 0.04 * R };
  }, { segs: 36, power: 2.3 }), undefined, { cavity: 0.1 });
  fb.add(cuffSlot, collar(0.62 * R, 0.73 * R, 0.62 * R, 0.9 * R, 36), new THREE.Matrix4().makeScale(1, 0.92, 1), { edgeMin: 0.15 });
  // Lacing on the palm side of the cuff.
  for (let k = 0; k < 3; k++) {
    const zz = 0.5 * R + k * 0.2 * R;
    fb.add('rubber', tube([V(0.18 * R, -s * 0.66 * R, zz), V(0, -s * 0.7 * R, zz + 0.07 * R), V(-0.18 * R, -s * 0.66 * R, zz)], 0.022 * R, 5, 3), undefined, { color: '#e9e6de' });
  }
}

/** Compact bare fist. Knuckle bumpers use `knuckle` (mech plates or black rubber). */
export function fistKnuckle(ctx: RecipeContext): void {
  const d = ctx.dims;
  const f = d.size.x / 2;
  const fy = d.size.y / 2;
  const s = ctx.side || 1;
  const fb = ctx.own;
  const rubber = ctx.style.limbs === 'hivis';
  const knuckle = (c: Vec, size: [number, number, number]) => {
    if (rubber) block(fb, 'rubber', c, V(1, 0, 0), V(0, 1, 0), size, { color: '#131313', cavity: 0.2 }, true);
    else block(fb, 'mech', c, V(1, 0, 0), V(0, 1, 0), size, { cavity: 0.2 }, true);
  };
  // Palm core and the back-of-hand plate.
  block(fb, 'frame', V(0, -s * 0.05 * fy, 0.18 * f), V(1, 0, 0), V(0, 1, 0), [1.62 * f, 1.3 * fy, 1.2 * f], { cavity: 0.4 }, true);
  block(fb, 'paint', V(0, s * 0.72 * fy, 0.12 * f), V(1, 0, 0), V(0, 1, 0), [1.72 * f, 0.34 * fy, 1.28 * f], { cavity: 0.1 }, true);
  // Four curled fingers: proximal segment at the knuckle face, middle and tip folded to the palm.
  const xs = [-0.66, -0.22, 0.22, 0.66].map((k) => k * f);
  const fw = 0.38 * f;
  for (const x of xs) {
    block(fb, 'frame', V(x, s * 0.1 * fy, -0.62 * f), V(1, 0, 0), V(0, 1, 0), [fw, 1.1 * fy, 0.52 * f], { cavity: 0.35 }, true);
    knuckle(V(x, s * 0.22 * fy, -0.92 * f), [fw * 0.96, 0.9 * fy, 0.16 * f]);
    block(fb, 'frame', V(x, -s * 0.62 * fy, -0.4 * f), V(1, 0, 0), V(0, 1, 0), [fw * 0.92, 0.5 * fy, 0.62 * f], { cavity: 0.45 }, true);
    block(fb, 'mech', V(x, -s * 0.66 * fy, -0.02 * f), V(1, 0, 0), V(0, 1, 0), [fw * 0.84, 0.42 * fy, 0.26 * f], { cavity: 0.5 }, true);
  }
  // Thumb folded across the front of the fingers.
  const thumbDir = V(0.12, -s * 0.4, -1).normalize();
  block(fb, 'frame', V(0.84 * f, -s * 0.34 * fy, -0.12 * f), thumbDir, V(1, 0, 0).cross(thumbDir).normalize(), [0.9 * f, 0.42 * f, 0.36 * f], { cavity: 0.3 }, true);
  knuckle(V(0.9 * f, -s * 0.5 * fy, -0.5 * f), [0.3 * f, 0.36 * fy, 0.24 * f]);
  // Wrist: bearing collar where the forearm drive ends.
  fb.add('mech', collar(f * 0.36, f * 0.74, f * 0.72, f * 1.0, 28), undefined, { cavity: 0.3 });
  fb.add('frame', cylinder(f * 0.36, f * 0.7, f * 1.02, 20), undefined, { cavity: 0.5 });
  if (ctx.style.limbs === 'hivis') fb.add('trim', collar(f * 0.74, f * 0.8, f * 0.8, f * 0.92, 28));
}
