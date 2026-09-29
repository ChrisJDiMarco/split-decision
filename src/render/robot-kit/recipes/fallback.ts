// Fallback recipe: dresses any part from its collision geoms, so a design with kit ids the kit
// does not know yet (a new quadruped leg, a wheel, a weapon) still renders as armored hardware
// in the right skin instead of crashing or showing grey primitives.
import * as THREE from 'three/webgpu';
import type { GeomDef } from '../../../core/types';
import { box, cylinder, lathe, sleeve } from '../geom/prims';
import { circleProfile, prismStations } from '../geom/sweep';
import { quatZTo } from '../geom/xf';
import type { RecipeContext } from './context';
import { housingRadius } from './context';
import { actuator, V } from './mech';

function boxGeom(ctx: RecipeContext, g: GeomDef & { shape: { type: 'box' } }): void {
  const [hx, hy, hz] = g.shape.halfSize;
  const pos = new THREE.Vector3(...(g.pos ?? [0, 0, 0]));
  const q = g.quat ? new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]) : new THREE.Quaternion();
  const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
  const slot = g.role === 'structure' ? 'frame' : g.role === 'foot' || g.role === 'wheel' ? 'rubber' : 'paint';
  ctx.own.add(slot, box(hx * 2, hy * 2, hz * 2, { bevel: Math.min(hx, hy, hz) * 0.3, round: ctx.style.round }), m, { accent: g.role === 'armor' && ctx.rand() < 0.3, color: slot === 'rubber' ? '#161616' : undefined });
  if (g.role === 'sensor') {
    const strip = box(0.01, hy * 1.2, hz * 0.25, { bevel: 0.003 });
    ctx.own.add('glow', strip, new THREE.Matrix4().makeTranslation(pos.x + hx, pos.y, pos.z + hz * 0.2));
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const p = new THREE.Vector3(sx * (hx - 0.02), sy * (hy - 0.02), hz).applyQuaternion(q).add(pos);
    ctx.own.bolt(p, new THREE.Vector3(0, 0, 1).applyQuaternion(q), ctx.style.boltSize, ctx.style.boltKind);
  }
}

function limbGeom(ctx: RecipeContext, from: THREE.Vector3, to: THREE.Vector3, r: number, wheel: boolean): void {
  const len = from.distanceTo(to);
  const dir = to.clone().sub(from).normalize();
  const m = new THREE.Matrix4().compose(from, quatZTo(dir), new THREE.Vector3(1, 1, 1));
  if (wheel) {
    // Tire with a shallow tread, steel rim and hub.
    ctx.own.add('rubber', lathe([[0, 0, 1], [r * 0.6, 0, 1], [r * 0.93, len * 0.02, 0], [r, len * 0.2, 0], [r, len * 0.8, 0], [r * 0.93, len * 0.98, 0], [r * 0.6, len, 1], [0, len, 1]], 40), m, { color: '#141414' });
    ctx.own.add('mech', cylinder(r * 0.62, -len * 0.04, len * 1.04, 28), m);
    return;
  }
  const st = prismStations(0, len, r * 0.35, { endSegs: 3, inset: [0.7, 0.7], segs: Math.max(1, Math.round(len / 0.05)) });
  ctx.own.add('paint', sleeve(circleProfile(r * 0.96, 28), st.filter((s) => s.sx !== 0)), m);
}

export function fallbackRecipe(ctx: RecipeContext): void {
  for (const g of ctx.part.geoms) {
    const s = g.shape;
    if (s.type === 'box') boxGeom(ctx, g as GeomDef & { shape: { type: 'box' } });
    else if (s.type === 'sphere') {
      const c = new THREE.Vector3(...(g.pos ?? [0, 0, 0]));
      const r = s.radius;
      const pairs: Array<[number, number, (0 | 1)?]> = [];
      for (let k = 0; k <= 10; k++) {
        const a = -Math.PI / 2 + (k / 10) * Math.PI;
        pairs.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
      }
      ctx.own.add('paint', lathe(pairs, 28), new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
    } else {
      limbGeom(ctx, new THREE.Vector3(...s.from), new THREE.Vector3(...s.to), s.radius, g.role === 'wheel');
    }
  }
  // An actuator housing on every joint axis, in the joint's stator frame.
  (ctx.part.joints ?? []).forEach((j, k) => {
    const R = housingRadius(ctx.part, k);
    actuator(ctx.frames[k], V(...j.axis), V(0, 0, 0), R, R * 0.9, ctx.style, { plainBack: true });
  });
}
