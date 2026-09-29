// Fists hang below the forearm; the knuckle face is -z (it meets the target when the arm
// extends), the palm faces the body midline. fist.block is a plated mechanical hand,
// fist.spiked adds knuckle spikes, fist.piston is a pneumatic ram with a spiked striking plate.
import * as THREE from 'three/webgpu';
import { box, collar, cylinder, lathe } from '../geom/prims';
import { alongZ } from '../geom/xf';
import { FrameBuilder, newObjState } from '../geom/part-builder';
import type { RecipeContext } from './context';
import { block, hoseLine, V, type Vec } from './mech';
import { facePlate } from './torso';

const RAM_TRAVEL = 0.42; // ram stroke as a fraction of the fist half-size
const RAM_SKILL = 'rocket';

function fistSize(ctx: RecipeContext): number {
  return ctx.dims.size.x / 2;
}

function spike(fb: FrameBuilder, base: Vec, dir: Vec, r: number, len: number): void {
  fb.add('mech', lathe([[0, 0, 1], [r, 0, 1], [r * 0.95, len * 0.18, 0], [r * 0.25, len * 0.9, 0], [0, len, 0]], 10), alongZ(base, dir), { edgeMin: 0.35 });
}

function knuckles(ctx: RecipeContext, f: number, s: number): void {
  const fb = ctx.own;
  const xs = [-0.69, -0.23, 0.23, 0.69].map((k) => k * f);
  for (const x of xs) {
    block(fb, 'frame', V(x, s * 0.14 * f, -0.46 * f), V(1, 0, 0), V(0, 1, 0), [0.4 * f, 1.18 * f, 0.56 * f], { cavity: 0.35 });
    block(fb, 'frame', V(x, -s * 0.6 * f, -0.2 * f), V(1, 0, 0), V(0, 1, 0), [0.38 * f, 0.56 * f, 0.72 * f], { cavity: 0.5 });
  }
  // Thumb folded across the front of the fingers.
  const thumbDir = V(0.2, -s * 0.35, -1).normalize();
  block(fb, 'frame', V(0.78 * f, -s * 0.45 * f, -0.05 * f), thumbDir, V(1, 0, 0).cross(thumbDir).normalize(), [0.95 * f, 0.42 * f, 0.4 * f], { cavity: 0.3 });
}

function wristCuff(ctx: RecipeContext, f: number): void {
  ctx.own.add('mech', collar(f * 0.42, f * 0.92, f * 0.7, f * 1.0, 28), undefined, { cavity: 0.3 });
}

export function fistBlock(ctx: RecipeContext): void {
  const f = fistSize(ctx);
  const s = ctx.side || 1;
  const fb = ctx.own;
  fb.add('paint', box(1.84 * f, 1.62 * f, 0.95 * f, { bevel: 0.16 * f, round: ctx.style.round, cell: 0.03 }), new THREE.Matrix4().makeTranslation(0, s * 0.06 * f, 0.3 * f), { cavity: 0.1 });
  knuckles(ctx, f, s);
  facePlate(ctx, fb, V(0, s * 0.06 * f, -0.78 * f), V(0, 0, -1), 1.86 * f, 1.5 * f, { bolts: 'corners', thick: 0.2 * f });
  wristCuff(ctx, f);
}

export function fistSpiked(ctx: RecipeContext): void {
  fistBlock(ctx);
  const f = fistSize(ctx);
  const s = ctx.side || 1;
  for (const x of [-0.6, -0.2, 0.2, 0.6]) spike(ctx.own, V(x * f, s * 0.06 * f, -0.97 * f), V(0, 0, -1), 0.13 * f, 0.34 * f);
}

/** The striking ram: rod, spiked plate and bolts, built as one assembly so it can fire. */
function ramAssembly(ctx: RecipeContext, f: number): THREE.Group {
  const ram = new FrameBuilder(`${ctx.part.id}.ram`, 17);
  ram.add('chrome', cylinder(0.34 * f, -0.6 * f, 0.3 * f, 20));
  ram.add('paint', box(1.95 * f, 1.72 * f, 0.4 * f, { bevel: 0.08 * f, round: ctx.style.round, cell: 0.03 }), new THREE.Matrix4().makeTranslation(0, 0, -0.78 * f), { accent: ctx.style.accents.has('fore.plate') });
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    spike(ram, V(x * 0.55 * f, y * 0.48 * f, -0.98 * f), V(0, 0, -1), 0.16 * f, 0.26 * f);
    ram.bolt(V(x * 0.8 * f, y * 0.7 * f, -0.58 * f), V(0, 0, 1), ctx.style.boltSize, ctx.style.boltKind);
  }
  const built = ram.finalize(ctx.mats, newObjState(0));
  // Hand the meshes to the part's shader state (heat, wear) when the fist frame finalises.
  built.group.traverse((o) => { delete o.userData.kit; });
  return built.group;
}

export function fistPiston(ctx: RecipeContext): void {
  const f = fistSize(ctx);
  const s = ctx.side || 1;
  const fb = ctx.own;
  fb.add('mech', cylinder(0.78 * f, -0.18 * f, 0.98 * f, 36, 0.06 * f), undefined, { cavity: 0.2 });
  fb.add('mech', collar(0.8 * f, 0.92 * f, 0.1 * f, 0.26 * f, 36));
  fb.add('mech', collar(0.8 * f, 0.92 * f, 0.55 * f, 0.7 * f, 36));
  const ram = ramAssembly(ctx, f);
  fb.object(ram);
  ctx.rams.push({ object: ram, part: ctx.part.id, dir: V(0, 0, -1), travel: RAM_TRAVEL * f, skill: RAM_SKILL, stroke: 0 });
  hoseLine(fb, [V(-0.5 * f, s * 0.5 * f, 0.9 * f), V(-0.95 * f, s * 0.7 * f, 0.4 * f), V(-0.8 * f, s * 0.62 * f, -0.05 * f)], 0.075 * f, ctx.style.hose);
  wristCuff(ctx, f);
}
