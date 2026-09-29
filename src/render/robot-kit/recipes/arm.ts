// arm.upper and arm.fore. The shoulder is a three-axis gimbal: the pitch drum sits on the
// torso, the roll drum and pauldron turn with pitch, the yaw drum turns with pitch and roll.
// Hydraulic forearms get triceps pistons from the upper arm to a lug behind the elbow, so the
// rods extend and retract with the elbow angle, plus wrist cylinders and hoses.
import * as THREE from 'three/webgpu';
import { collar, cylinder, shell } from '../geom/prims';
import { alongZ } from '../geom/xf';
import { labelDecal, limbCables, limbCore, limbPlate, numberDecal } from './common';
import { housingRadius, isHydraulic, type RecipeContext } from './context';
import { actuator, basis, block, clevis, flange, hoseLine, pin, V, type Vec } from './mech';

const PISTON_BARREL_FRACTION = 0.52; // barrel length / longest pin-to-pin distance

function capsuleOf(ctx: RecipeContext, partId: string): { r: number; L: number } {
  const p = ctx.design.parts.find((q) => q.id === partId);
  const g = p?.geoms.find((x) => x.shape.type === 'capsule' || x.shape.type === 'cylinder');
  if (!g || (g.shape.type !== 'capsule' && g.shape.type !== 'cylinder')) return { r: ctx.dims.radius, L: ctx.dims.length };
  const s = g.shape;
  return { r: s.radius, L: Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]) };
}

/** Shoulder pitch drum on the torso, roll drum and pauldron on the pitch frame, yaw drum below. */
function shoulder(ctx: RecipeContext, r: number): void {
  const s = ctx.side || 1;
  const [f0, f1, f2] = ctx.frames;
  const torsoHalfY = ctx.parentDims ? ctx.parentDims.size.y / 2 : Math.abs(ctx.part.pos[1]) * 0.8;
  const gap = Math.max(0.02, Math.abs(ctx.part.pos[1]) - torsoHalfY);
  const R0 = housingRadius(ctx.part, 0) * 1.05;
  const W0 = gap + 0.014;
  actuator(f0, V(0, s, 0), V(0, s * (W0 / 2 - gap), 0), R0, W0, ctx.style, { plainBack: true, fins: ctx.style.id === 'industrial' ? 2 : 0 });
  if (!f1 || !f2) return;
  flange(f1, V(0, s, 0), V(0, s * (W0 - gap + 0.006), 0), R0 * 0.82, 0.012, ctx.style);
  const R1 = housingRadius(ctx.part, 1) * 0.8;
  actuator(f1, V(1, 0, 0), V(0, s * 0.01, -0.005), R1, R1 * 1.25, ctx.style, { hidden: true });
  pauldron(ctx, r, R0);
  const R2 = r * 1.02;
  actuator(f2, V(0, 0, -1), V(0, 0, -r * 0.72), R2, r * 0.5, ctx.style, { plainBack: true });
}

function pauldron(ctx: RecipeContext, r: number, R0: number): void {
  const f1 = ctx.frames[1];
  const size = ctx.style.pauldron;
  if (!f1 || size <= 0) return;
  const s = ctx.side || 1;
  const rIn = Math.max(R0 * 1.28, r * 1.28) * (1 + 0.12 * (size - 1));
  const thick = ctx.style.plate * 1.3;
  const half = r * (1.1 + 0.5 * size);
  // Shell built along z with its arc in x/y: map build x → up, build y → outward, build z → forward.
  const g = shell(rIn, rIn + thick, -0.45, 2.0, -half, half, { taper: 1, arcSegs: 14 });
  const m = basis(V(0, 0, 1), V(0, s, 0), V(1, 0, 0), V(0, 0, 0.012));
  f1.add('paint', g, m, { accent: ctx.style.accents.has('pauldron') });
  // Rivet rows along the front and back edges.
  const rows = ctx.style.boltDensity > 0.6 ? 7 : 4;
  for (const x of [-half * 0.82, half * 0.82]) {
    for (let i = 0; i < rows; i++) {
      const a = -0.3 + (2.2 * i) / (rows - 1);
      const n = V(0, s * Math.sin(a), Math.cos(a));
      f1.bolt(V(x, 0, 0.012).addScaledVector(n, rIn + thick), n, ctx.style.boltSize * 0.85, ctx.style.boltKind);
    }
  }
}

export function armUpper(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const child = ctx.design.parts.find((p) => p.parent === ctx.part.id);
  const L = child ? -child.pos[2] : ctx.dims.length; // elbow joint, not just the capsule end
  const fb = ctx.own;
  shoulder(ctx, r);
  flange(fb, V(0, 0, -1), V(0, 0, -r * 1.02), r * 0.92, 0.014, ctx.style);
  limbCore(ctx, fb, -r * 1.08, -(L - r * 0.25), r * 1.62, r * 1.56, { taper: 0.92 });
  limbPlate(ctx, fb, 'front', -r * 1.18, -(L - r * 0.55), r * 0.8, { width: r * 1.52, taper: 0.86, accent: 'arm.front', bolts: 'edges', decal: ctx.style.id === 'sleek' ? undefined : numberDecal('x', [0.15, 0.25, 0.85, 0.75]) });
  limbPlate(ctx, fb, 'outer', -r * 1.3, -(L - r * 0.75), r * 0.8, { width: r * 1.32, taper: 0.9, bolts: 'corners', decal: labelDecal(ctx.side >= 0 ? 'y' : '-y', [0.1, 0.1, 0.9, 0.9], true) });
  limbCables(ctx, fb, ctx.style.hoses ? 'inner' : 'back', -r * 1.1, -(L - r * 0.4), r * 0.78, 3, r * 0.1);
  // Elbow fork: the forearm's elbow drum or pin sits between the plates.
  clevis(fb, 'frame', V(0, 1, 0), V(0, 0, -L), V(0, 0, 1), r * 1.55, r * 0.86, Math.max(0.012, r * 0.2), L * 0.32, { cavity: 0.2 });
}

// ---------------------------------------------------------------- forearm

/** Pin-to-pin distance of an elbow piston at elbow angle `theta` (hinge about y at `pivot`). */
function pistonSpan(a: Vec, bChild: Vec, pivot: Vec, theta: number): number {
  const b = bChild.clone().applyAxisAngle(V(0, 1, 0), theta).add(pivot);
  return a.distanceTo(b);
}

function tricepsPistons(ctx: RecipeContext, r: number): void {
  const parentId = ctx.part.parent;
  if (!parentId) return;
  const up = capsuleOf(ctx, parentId);
  const j = ctx.part.joints?.[0];
  const range = j ? j.rangeDeg.map((d) => (d * Math.PI) / 180) : [-2.6, 0];
  const pivot = V(...ctx.part.pos);
  for (const y of [-1, 1]) {
    const lateral = y * up.r * 0.98;
    const a = V(-up.r * 0.92, lateral, -up.r * 1.35);
    const b = V(-r * 0.98, lateral, r * 0.34);
    const spans = [range[0], (range[0] + range[1]) / 2, range[1]].map((t) => pistonSpan(a, b, pivot, t));
    const barrel = Math.max(...spans) * PISTON_BARREL_FRACTION;
    ctx.linkages.push({ kind: 'piston', parent: parentId, child: ctx.part.id, anchorParent: a, anchorChild: b, radius: up.r * 0.24, barrelLength: Math.min(barrel, Math.min(...spans) * 0.98) });
    ctx.own.anchor(`leak.piston${y > 0 ? 'L' : 'R'}`, b);
  }
  // Olecranon lug that the rods pin to, behind and above the elbow.
  block(ctx.own, 'mech', V(-r * 0.72, 0, r * 0.2), V(1, 0, 0), V(0, 1, 0), [r * 0.7, up.r * 2.1, r * 0.45], { cavity: 0.3 });
  pin(ctx.own, V(0, 1, 0), V(-r * 0.98, 0, r * 0.34), r * 0.09, up.r * 2.3);
}

function wristCylinders(ctx: RecipeContext, r: number, L: number): void {
  const fb = ctx.own;
  for (const y of [-1, 1]) {
    const x = -r * 0.9;
    const yy = y * r * 0.42;
    fb.add('frame', cylinder(r * 0.17, -L * 0.72, -L * 0.28, 18, r * 0.04), new THREE.Matrix4().makeTranslation(x, yy, 0), { cavity: 0.2 });
    fb.add('mech', collar(r * 0.16, r * 0.22, -L * 0.72, -L * 0.66, 18), new THREE.Matrix4().makeTranslation(x, yy, 0));
    fb.add('chrome', cylinder(r * 0.075, -L * 0.93, -L * 0.7, 12), new THREE.Matrix4().makeTranslation(x, yy, 0));
    hoseLine(fb, [V(x - r * 0.05, yy, -L * 0.32), V(x - r * 0.12, yy * 1.2, -L * 0.2), V(-r * 0.6, yy * 1.5, -r * 0.3)], r * 0.07, ctx.style.hose);
    ctx.own.anchor(`leak.wrist${y > 0 ? 'L' : 'R'}`, V(x, yy, -L * 0.7));
  }
}

export function armFore(ctx: RecipeContext): void {
  const r = ctx.dims.radius;
  const L = ctx.dims.length;
  const fb = ctx.own;
  const hydraulic = ctx.params.hydraulic === true || isHydraulic(ctx.part);
  const upper = ctx.part.parent ? capsuleOf(ctx, ctx.part.parent) : { r, L };
  const gap = upper.r * 1.55;
  const f0 = ctx.frames[0];
  if (f0 && ctx.frames.length > 1) {
    if (hydraulic) pin(f0, V(0, 1, 0), V(0, 0, 0), r * 0.16, gap + upper.r * 0.55);
    else actuator(f0, V(0, ctx.side || 1, 0), V(0, 0, 0), housingRadius(ctx.part, 0), gap * 0.94, ctx.style);
  }
  fb.add('mech', cylinder(r * 0.78, -gap * 0.46, gap * 0.46, 32, 0.008), alongZ(V(0, 0, 0), V(0, 1, 0)), { cavity: 0.3 });
  limbCore(ctx, fb, -r * 0.62, -(L - 0.012), r * 1.66, r * 1.6, { taper: 1.12 });
  limbPlate(ctx, fb, 'front', -r * 0.7, -(L - r * 0.25), r * 0.86, { width: r * 1.58, taper: 1.15, accent: 'fore.plate', bolts: 'edges' });
  limbPlate(ctx, fb, 'outer', -r * 0.8, -(L - r * 0.35), r * 0.86, { width: r * 1.38, taper: 1.1, bolts: 'corners', accent: ctx.style.id === 'industrial' ? 'fore.plate' : undefined });
  fb.add('mech', collar(r * 0.5, r * 0.96, -L - 0.012, -L + 0.022, 32), undefined, { cavity: 0.3 });
  if (hydraulic) {
    tricepsPistons(ctx, r);
    if (ctx.style.hoses) wristCylinders(ctx, r, L);
  } else {
    limbCables(ctx, fb, 'back', -r * 0.5, -(L - r * 0.3), r * 0.78, 3, r * 0.09);
  }
}
