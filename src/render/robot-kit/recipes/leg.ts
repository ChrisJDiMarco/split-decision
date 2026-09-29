// leg.thigh, leg.shin and leg.foot. The hip is a three-axis stack (yaw under the pelvis, roll,
// then the big pitch drum on the outside of the thigh). An electric knee is a drum in a fork at
// the bottom of the thigh; a hydraulic knee is a pinned fork driven by twin cylinders behind the
// knee, so the rods move with the knee angle. Hydraulic styles drive the ankle with a calf piston.
import * as THREE from 'three/webgpu';
import type { PartDef } from '../../../core/types';
import { box, collar, cylinder } from '../geom/prims';
import { alongZ } from '../geom/xf';
import { limbCables, limbCore, limbPlate, numberDecal } from './common';
import { housingRadius, isHydraulic, type RecipeContext } from './context';
import { actuator, block, clevis, flange, hoseLine, pin, V, type Vec } from './mech';
import { facePlate } from './torso';

const PISTON_BARREL_FRACTION = 0.52;

function childOf(ctx: RecipeContext): PartDef | undefined {
  return ctx.design.parts.find((p) => p.parent === ctx.part.id);
}

function capsuleRadius(p: PartDef | undefined, fallback: number): number {
  const g = p?.geoms.find((x) => x.shape.type === 'capsule');
  return g && g.shape.type === 'capsule' ? g.shape.radius : fallback;
}

/** Distance down to the joint below (the child's origin), falling back to the collision length. */
function jointBelow(ctx: RecipeContext): number {
  const c = childOf(ctx);
  return c ? -c.pos[2] : ctx.dims.length;
}

/** Barrel length for a piston that must cover every pin-to-pin span over a hinge's range. */
function barrelFor(a: Vec, b: Vec, pivot: Vec, axis: Vec, range: [number, number]): number {
  const spans = [range[0], (range[0] + range[1]) / 2, range[1]].map((t) => a.distanceTo(b.clone().applyAxisAngle(axis, t).add(pivot)));
  return Math.min(Math.max(...spans) * PISTON_BARREL_FRACTION, Math.min(...spans) * 0.98);
}

function hydraulicLine(ctx: RecipeContext, zTop: number, zBot: number, x: number): void {
  if (!ctx.part.tags.includes('hydraulic')) return;
  const s = ctx.side || 1;
  const y = -s * ctx.dims.radius * 0.72;
  hoseLine(ctx.own, [V(x, y, zTop), V(x - 0.012, y * 1.08, (zTop + zBot) / 2), V(x, y, zBot)], ctx.dims.radius * 0.1, ctx.style.hose);
  ctx.own.anchor('leak.line', V(x, y, (zTop + zBot) / 2));
}

export function legThigh(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = jointBelow(ctx);
  const s = ctx.side || 1;
  const fb = ctx.own;
  const [f0, f1, f2] = ctx.frames;
  if (f0 && f1 && f2 && ctx.frames.length > 3) {
    actuator(f0, V(0, 0, -1), V(0, 0, r * 0.32), housingRadius(ctx.part, 0) * 0.95, r * 0.52, ctx.style, { plainBack: true });
    const Rr = housingRadius(ctx.part, 1) * 0.78;
    actuator(f1, V(1, 0, 0), V(0, 0, -r * 0.08), Rr, Rr * 1.3, ctx.style, { hidden: true });
    const Rp = housingRadius(ctx.part, 2) * 1.05;
    const W = r * 0.62;
    actuator(f2, V(0, s, 0), V(0, s * (r * 0.62), -r * 0.12), Rp, W, ctx.style, { fins: ctx.style.id === 'sleek' ? 0 : 3, plainBack: true });
    flange(fb, V(0, s, 0), V(0, s * (r * 0.62 + W / 2 + 0.007), -r * 0.12), Rp * 0.78, 0.014, ctx.style);
  }
  limbCore(ctx, fb, -r * 0.62, -(L - r * 0.45), r * 1.72, r * 1.66, { taper: 0.84 });
  limbPlate(ctx, fb, 'front', -r * 0.7, -(L - r * 0.85), r * 0.84, { width: r * 1.5, taper: 0.78, accent: 'thigh.front', bolts: 'edges', decal: numberDecal('x', [0.15, 0.3, 0.85, 0.72]) });
  limbPlate(ctx, fb, 'outer', -r * 1.35, -(L - r * 0.95), r * 0.86, { width: r * 1.35, taper: 0.82, accent: 'thigh.side', bolts: 'corners' });
  limbPlate(ctx, fb, 'inner', -r * 0.9, -(L - r * 1.1), r * 0.82, { width: r * 1.15, taper: 0.85, bolts: 'none', thick: ctx.style.plate * 0.8 });
  limbCables(ctx, fb, 'back', -r * 0.6, -(L - r * 0.6), r * 0.84, ctx.style.exposed > 0.6 ? 4 : 2, r * 0.085);
  hydraulicLine(ctx, -r * 0.9, -(L - r * 1.2), -r * 0.55);
  const rc = capsuleRadius(childOf(ctx), r * 0.85);
  clevis(fb, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), rc * 1.55, rc * 0.95, Math.max(0.014, r * 0.17), L * 0.3, { cavity: 0.2 });
}

/** Hydraulic knee: pinned fork plus twin cylinders from the back of the thigh to a lug on the shin. */
function hydraulicKnee(ctx: RecipeContext, r: number): void {
  const thigh = ctx.design.parts.find((p) => p.id === ctx.part.parent);
  if (!thigh) return;
  const rt = capsuleRadius(thigh, r * 1.15);
  const Lt = -ctx.part.pos[2];
  const f0 = ctx.frames[0];
  if (f0) pin(f0, V(0, 1, 0), V(0, 0, 0), r * 0.17, r * 1.55 + rt * 0.5);
  const j = ctx.part.joints?.[0];
  const range: [number, number] = j ? [j.rangeDeg[0] * (Math.PI / 180), j.rangeDeg[1] * (Math.PI / 180)] : [0, 2.6];
  for (const y of [-1, 1]) {
    const lateral = y * rt * 0.92;
    const a = V(-rt * 0.8, lateral, -Lt * 0.42);
    const b = V(-r * 1.0, lateral, r * 0.38);
    ctx.linkages.push({ kind: 'piston', parent: thigh.id, child: ctx.part.id, anchorParent: a, anchorChild: b, radius: rt * 0.22, barrelLength: barrelFor(a, b, V(...ctx.part.pos), V(0, 1, 0), range) });
    ctx.own.anchor(`leak.knee${y > 0 ? 'L' : 'R'}`, b);
  }
  block(ctx.own, 'mech', V(-r * 0.78, 0, r * 0.22), V(1, 0, 0), V(0, 1, 0), [r * 0.6, rt * 1.95, r * 0.48], { cavity: 0.3 });
  pin(ctx.own, V(0, 1, 0), V(-r * 1.0, 0, r * 0.38), r * 0.09, rt * 2.1);
}

/** Ankle drive: a calf piston pinned to a heel lug (hydraulic styles) or a calf motor pod. */
function calf(ctx: RecipeContext, r: number, L: number): void {
  const fb = ctx.own;
  const foot = childOf(ctx);
  if (ctx.style.hoses && foot) {
    const heel = foot.geoms[0]?.shape.type === 'box' ? foot.geoms[0] : null;
    const heelX = heel && heel.shape.type === 'box' ? (heel.pos?.[0] ?? 0) - heel.shape.halfSize[0] * 0.75 : -0.08;
    const a = V(-r * 1.02, 0, -L * 0.3);
    const b = V(heelX, 0, 0.012);
    ctx.linkages.push({ kind: 'piston', parent: ctx.part.id, child: foot.id, anchorParent: a, anchorChild: b, radius: r * 0.22, barrelLength: barrelFor(a, b, V(...foot.pos), V(0, 1, 0), [-0.9, 0.8]) });
    block(fb, 'mech', V(-r * 0.86, 0, -L * 0.3), V(1, 0, 0), V(0, 1, 0), [r * 0.34, r * 0.62, r * 0.4], { cavity: 0.4 });
    fb.anchor('leak.calf', a);
    return;
  }
  fb.add(ctx.style.id === 'titan' ? 'paint' : 'frame', box(r * 0.95, r * 1.25, L * 0.4, { bevel: r * 0.2, round: ctx.style.round, cell: 0.04, taper: 0.8 }), new THREE.Matrix4().makeTranslation(-r * 0.58, 0, -L * 0.34), { cavity: 0.3 });
}

export function legShin(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = jointBelow(ctx);
  const s = ctx.side || 1;
  const fb = ctx.own;
  const f0 = ctx.frames[0];
  const hydraulic = isHydraulic(ctx.part);
  if (hydraulic) hydraulicKnee(ctx, r);
  else if (f0 && ctx.frames.length > 1) actuator(f0, V(0, s, 0), V(0, 0, 0), housingRadius(ctx.part, 0), r * 1.48, ctx.style, { fins: ctx.style.id === 'industrial' ? 2 : 0 });
  fb.add('mech', cylinder(r * 0.7, -r * 0.7, r * 0.7, 30, 0.008), alongZ(V(0, 0, 0), V(0, 1, 0)), { cavity: 0.3 });
  facePlate(ctx, fb, V(r * 0.78, 0, -r * 0.25), V(1, 0, 0.45), r * 1.25, r * 1.5, { accent: 'knee', bolts: 'corners', thick: ctx.style.plate * 1.1 });
  limbCore(ctx, fb, -r * 0.75, -(L - r * 0.45), r * 1.45, r * 1.4, { taper: 0.82 });
  limbPlate(ctx, fb, 'front', -r * 1.35, -(L - r * 0.8), r * 0.76, { width: r * 1.45, taper: 0.72, accent: 'shin', bolts: 'edges' });
  limbPlate(ctx, fb, 'outer', -r * 1.1, -(L - r * 1.4), r * 0.76, { width: r * 1.15, taper: 0.8, bolts: 'none', thick: ctx.style.plate * 0.8 });
  calf(ctx, r, L);
  limbCables(ctx, fb, 'inner', -r * 0.5, -(L - r * 0.5), r * 0.66, 2, r * 0.08);
  hydraulicLine(ctx, -r * 1.3, -(L - r * 1.3), -r * 0.5);
  clevis(fb, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.1, r * 0.72, Math.max(0.012, r * 0.16), L * 0.24, { cavity: 0.2 });
}

export function legFoot(ctx: RecipeContext): void {
  const d = ctx.dims;
  const s = ctx.side || 1;
  const fb = ctx.own;
  const [f0, f1] = ctx.frames;
  const wx = d.size.x;
  const wy = d.size.y;
  const cx = d.center.x;
  const zb = d.min.z;
  const zt = d.max.z;
  if (f0 && f1 && ctx.frames.length > 2) {
    actuator(f0, V(0, s, 0), V(0, 0, 0), housingRadius(ctx.part, 0) * 0.72, wy * 0.62, ctx.style);
    actuator(f1, V(1, 0, 0), V(0, 0, -0.004), wy * 0.24, wy * 0.5, ctx.style, { hidden: true });
  }
  // Rubber sole, frame body, heel block.
  fb.add('rubber', box(wx * 0.98, wy * 0.98, (zt - zb) * 0.34, { bevel: 0.008, round: true, cell: 0.05 }), new THREE.Matrix4().makeTranslation(cx, 0, zb + (zt - zb) * 0.17), { color: '#121212', cavity: 0.2 });
  fb.add('frame', box(wx * 0.9, wy * 0.9, (zt - zb) * 0.55, { bevel: 0.01, round: ctx.style.round, cell: 0.05 }), new THREE.Matrix4().makeTranslation(cx - wx * 0.02, 0, zb + (zt - zb) * 0.6), { cavity: 0.4 });
  block(fb, 'mech', V(d.min.x + wx * 0.1, 0, zb + (zt - zb) * 0.55), V(1, 0, 0), V(0, 1, 0), [wx * 0.16, wy * 0.8, (zt - zb) * 0.7], { cavity: 0.3 });
  facePlate(ctx, fb, V(d.max.x - wx * 0.16, 0, zt - (zt - zb) * 0.05), V(0.75, 0, 1), wx * 0.3, wy * 0.86, { accent: 'foot.toe', bolts: 'corners' });
  facePlate(ctx, fb, V(cx - wx * 0.12, 0, zt + 0.002), V(0.1, 0, 1), wx * 0.36, wy * 0.72, { bolts: 'corners' });
  if (ctx.style.id === 'titan') {
    for (const y of [-0.3, 0, 0.3]) block(fb, 'paint', V(d.max.x - wx * 0.02, y * wy, zb + (zt - zb) * 0.35), V(1, 0, -0.3).normalize(), V(0, 1, 0), [wx * 0.14, wy * 0.24, (zt - zb) * 0.5], {}, true);
  }
  // Ankle yoke: fork around the roll axis, rising from the foot body.
  clevis(fb, 'frame', V(1, 0, 0), V(0, 0, -0.004), V(0, 0, -1), wy * 0.5, wy * 0.26, 0.012, Math.max(0.02, -zt), { cavity: 0.2 });
  fb.add('mech', collar(wy * 0.12, wy * 0.2, zt - 0.004, zt + 0.004, 16));
}
