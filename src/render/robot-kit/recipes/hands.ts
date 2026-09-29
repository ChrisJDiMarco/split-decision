// Hand loadout visuals (docs/design/loadouts-and-workshop.md). The fist part keeps its physics
// frame: knuckle face -z, palm toward the body midline (-side·y), back of the hand out (+side·y),
// fingers along x with the index and thumb at +x.
//   hand.palm    the palm of a dexterous hand (src/robots/hands.ts): shell, back cover over the
//                grip drive, palm pad, knuckle axle, tendon sheaths, wrist bearing. The physics
//                phalanges are child parts that draw themselves with hand.digit and follow their
//                bodies. A palm with no phalanx parts (a visual-only preview) draws the same
//                fingers itself on pivots that hands.ts curls from the grip.
//   hand.digit   one phalanx from its collision capsule; its flexion drum sits in the joint frame
//                on the parent, the rubber pad on the palm side of the fingertip.
//   fist.plate   bare mechanical fist behind a bolted AR500 knuckle plate (the 'knuckle' loadout
//                on a design that is gloved as built).
// All of them use coarse unsubdivided shapes so a hands loadout stays inside the triangle and
// draw-call budgets.
import * as THREE from 'three/webgpu';
import type { PartDef } from '../../../core/types';
import { digitParts } from '../../../robots/hands';
import { FrameBuilder, newObjState } from '../geom/part-builder';
import type { SurfOpts } from '../geom/attrs';
import { box, collar, cylinder, lathe } from '../geom/prims';
import { alongZ } from '../geom/xf';
import type { FingerJoint, MatSlot } from '../types';
import type { RecipeContext } from './context';
import { basis, V, type Vec } from './mech';

const DEG = Math.PI / 180;

/** Flexion (rad) of the kit-drawn fingers, proximal / distal, mirroring src/robots/hands.ts. */
export const FINGER_FLEX = { p: { open: 8 * DEG, fist: 86 * DEG, brace: -10 * DEG }, d: { open: 8 * DEG, fist: 97 * DEG, brace: 0 } };
export const THUMB_FLEX = { p: { open: 8 * DEG, fist: 58 * DEG, brace: -10 * DEG }, d: { open: 8 * DEG, fist: 62 * DEG, brace: 0 } };

/** Stock fist half-size the hand is scaled from (the palm part carries it as params.h). */
function handH(ctx: RecipeContext): number {
  const h = ctx.params.h;
  return typeof h === 'number' && h > 0 ? h : ctx.dims.size.x / 2;
}

function sideSign(ctx: RecipeContext): 1 | -1 {
  return ctx.side === -1 ? -1 : 1;
}

// ---------------------------------------------------------------- light primitives

// Hands are twelve small parts per side, so they use coarse, unsubdivided shapes: a dexterous
// loadout must stay inside the per-robot triangle and draw-call budgets (tests/robot-kit).
const DRUM_SEGS = 12;
const SHELL_SEGS = 10;

/** Chamfered box with no dent subdivision. */
function lite(fb: FrameBuilder, slot: MatSlot, center: Vec, u: Vec, v: Vec, size: [number, number, number], surf: SurfOpts = {}): void {
  const w = new THREE.Vector3().crossVectors(u, v).normalize();
  const [a, b, c] = size;
  fb.add(slot, box(a, b, c, { bevel: Math.min(a, b, c) * 0.22, cell: 1, capRings: 0 }), basis(u, v, w, center), surf);
}

// ---------------------------------------------------------------- palm

function palm(ctx: RecipeContext, h: number, s: number): void {
  const fb = ctx.own;
  const top = 1.0 * h;
  const knuckle = -0.7 * h;
  const mid = (top + knuckle) / 2;
  const len = top - knuckle;
  const X = V(1, 0, 0);
  const Y = V(0, 1, 0);
  // Palm core, the moulded back-of-hand cover in the livery, the rubber palm pad.
  lite(fb, 'frame', V(0, s * 0.03 * h, mid), X, Y, [1.7 * h, 0.82 * h, len * 0.96], { cavity: 0.35 });
  fb.add('paint', box(1.78 * h, 0.2 * h, len * 0.86, { bevel: 0.08 * h, round: true, cell: 1, capRings: 0 }), new THREE.Matrix4().makeTranslation(0, s * 0.46 * h, mid + 0.06 * h), { cavity: 0.1 });
  lite(fb, 'rubber', V(-0.06 * h, -s * 0.43 * h, mid - 0.04 * h), X, Y, [1.34 * h, 0.08 * h, len * 0.66], { color: '#161616', cavity: 0.3 });
  // Grip drive can under the back cover, and the tendon sheaths running down to the knuckles.
  const can = alongZ(V(-0.1 * h, s * 0.56 * h, mid + 0.18 * h), V(0, s, 0));
  fb.add('mech', collar(0.16 * h, 0.4 * h, -0.05 * h, 0.03 * h, 20), can, { cavity: 0.2 });
  fb.add('frame', cylinder(0.16 * h, -0.05 * h, 0.05 * h, 14), can, { cavity: 0.4 });
  for (const x of [-0.5, 0, 0.5]) lite(fb, 'mech', V(x * h, s * 0.58 * h, knuckle + len * 0.3), X, Y, [0.1 * h, 0.06 * h, len * 0.42], { cavity: 0.4 });
  // Knuckle axle under the four finger roots; the thumb's saddle on the heel of the palm.
  fb.add('mech', cylinder(0.14 * h, -0.86 * h, 0.86 * h, DRUM_SEGS, 0.03 * h), alongZ(V(0, -s * 0.15 * h, knuckle), X), { cavity: 0.3 });
  lite(fb, 'frame', V(0.9 * h, -s * 0.24 * h, 0.2 * h), V(0, 0, 1), Y, [0.4 * h, 0.44 * h, 0.2 * h], { cavity: 0.3 });
  // Wrist bearing where the forearm drive ends.
  fb.add('mech', collar(h * 0.36, h * 0.74, top - 0.24 * h, top + 0.02 * h, 20), undefined, { cavity: 0.3 });
  fb.add('frame', cylinder(h * 0.36, top - 0.28 * h, top + 0.04 * h, 14), undefined, { cavity: 0.5 });
}

// ---------------------------------------------------------------- phalanges

interface Phalanx {
  len: number;
  r: number;
  axis: Vec; // flexion axis, in the phalanx frame
  tip: boolean;
}

/** Palm-side unit for a phalanx hanging along -z that flexes about `axis`. */
function palmSide(axis: Vec): Vec {
  return new THREE.Vector3().crossVectors(axis, V(0, 0, -1)).normalize();
}

/**
 * The phalanx in its own frame (hangs along -z from the joint at the origin): a rounded shell,
 * the flexion drum on the joint axis (round about its axis, so it can ride on the link), a dark
 * dorsal cover and, on a fingertip, a grip pad on the palm side.
 */
function phalanxShell(fb: FrameBuilder, p: Phalanx): void {
  const side = palmSide(p.axis);
  const across = p.axis.clone().normalize();
  const dir = V(0, 0, -1);
  const r = p.r * 0.95;
  const end = p.len + (p.tip ? r * 0.9 : r * 0.35);
  fb.add('frame', lathe([[0, r * 0.2, 1], [r * 0.8, r * 0.1, 0], [r, -r * 0.3, 0], [r * 0.94, -end + r * 0.55, 0], [r * 0.62, -end + r * 0.1, 0], [0, -end, 0]], SHELL_SEGS), undefined, { cavity: 0.3 });
  fb.add('frame', cylinder(p.r * 1.02, -p.r * 0.82, p.r * 0.82, DRUM_SEGS, p.r * 0.14), alongZ(V(0, 0, 0), across), { cavity: 0.3 });
  lite(fb, 'mech', V(0, 0, -p.len * 0.5).addScaledVector(side, -r * 0.92), dir, across, [p.len * 0.66, r * 1.5, r * 0.34], { cavity: 0.2 });
  if (p.tip) lite(fb, 'mech', V(0, 0, -p.len * 0.7).addScaledVector(side, r * 0.9), dir, across, [p.len * 0.56, r * 1.4, r * 0.3], { cavity: 0.2 });
}

function capsuleOf(part: PartDef): { len: number; r: number } | null {
  const g = part.geoms.find((x) => x.shape.type === 'capsule' || x.shape.type === 'cylinder');
  if (!g || (g.shape.type !== 'capsule' && g.shape.type !== 'cylinder')) return null;
  const len = Math.hypot(g.shape.to[0] - g.shape.from[0], g.shape.to[1] - g.shape.from[1], g.shape.to[2] - g.shape.from[2]);
  return { len, r: g.shape.radius };
}

/** A physics phalanx part (tags 'finger', parent the palm or the proximal phalanx). */
export function handDigit(ctx: RecipeContext): void {
  const cap = capsuleOf(ctx.part);
  const axis = V(...(ctx.part.joints?.[0]?.axis ?? [1, 0, 0])).normalize();
  if (!cap) {
    const d = ctx.dims;
    lite(ctx.own, 'frame', d.center, V(1, 0, 0), V(0, 1, 0), [d.size.x, d.size.y, d.size.z], { cavity: 0.3 });
    return;
  }
  const tip = !ctx.design.parts.some((p) => p.parent === ctx.part.id);
  phalanxShell(ctx.own, { ...cap, axis, tip });
}

/** A link built in its own pivot frame; its meshes take the fist's shader state on finalize. */
function link(ctx: RecipeContext, name: string, p: Phalanx): THREE.Group {
  const fb = new FrameBuilder(`${ctx.part.id}.${name}`, 59 + name.length);
  phalanxShell(fb, p);
  const g = fb.finalize(ctx.mats, newObjState(0)).group;
  g.traverse((o) => { delete o.userData.kit; });
  return g;
}

/** Draw the physics layout's fingers on kit pivots (a palm with no phalanx bodies). */
function drawnFingers(ctx: RecipeContext, h: number, s: 1 | -1): void {
  const digits = digitParts(ctx.part.id, s === 1 ? 'l' : 'r', h);
  const byId = new Map(digits.map((d) => [d.id, d]));
  const pivots = new Map<string, THREE.Group>();
  for (const d of digits) {
    const cap = capsuleOf(d);
    if (!cap) continue;
    const axis = V(...(d.joints?.[0]?.axis ?? [1, 0, 0])).normalize();
    const tip = !digits.some((q) => q.parent === d.id);
    const pivot = new THREE.Group();
    pivot.name = `${ctx.part.id}:${d.id}`;
    pivot.position.set(...d.pos);
    pivot.add(link(ctx, d.id, { ...cap, axis, tip }));
    const parent = d.parent ? pivots.get(d.parent) : undefined;
    if (parent) parent.add(pivot);
    else ctx.own.object(pivot);
    pivots.set(d.id, pivot);
    const thumb = d.visual.params?.thumb === true;
    const seg = byId.get(d.parent ?? '') ? 'd' : 'p';
    const pose = (thumb ? THUMB_FLEX : FINGER_FLEX)[seg];
    const joint: FingerJoint = { part: ctx.part.id, side: s, pivot, axis, pose };
    ctx.fingers.push(joint);
  }
}

export function handPalm(ctx: RecipeContext): void {
  const h = handH(ctx);
  const s = sideSign(ctx);
  palm(ctx, h, s);
  if (ctx.design.parts.some((p) => p.parent === ctx.part.id)) return; // physics phalanges draw themselves
  drawnFingers(ctx, h, s);
}

// ---------------------------------------------------------------- knuckle plates

/**
 * Bare mechanical fist behind a bolted AR500 knuckle plate: palm block, back-of-hand cover,
 * curled fingers and thumb, the plate with four raised ridges, side straps and a wrist bearing.
 */
export function fistPlate(ctx: RecipeContext): void {
  const f = ctx.dims.size.x / 2;
  const fy = ctx.dims.size.y / 2;
  const s = sideSign(ctx);
  const fb = ctx.own;
  const X = V(1, 0, 0);
  const Y = V(0, 1, 0);
  const iron = ctx.style.limbs === 'iron';
  // Palm core and the back-of-hand cover.
  lite(fb, 'frame', V(0, -s * 0.05 * fy, 0.2 * f), X, Y, [1.62 * f, 1.3 * fy, 1.1 * f], { cavity: 0.4 });
  fb.add('paint', box(1.72 * f, 0.34 * fy, 1.24 * f, { bevel: 0.1 * f, round: !iron, cell: 1, capRings: 0 }), new THREE.Matrix4().makeTranslation(0, s * 0.72 * fy, 0.14 * f), { cavity: 0.1 });
  // Four curled fingers: the proximal links behind the plate, the tips folded to the palm.
  for (const x of [-0.66, -0.22, 0.22, 0.66]) {
    lite(fb, 'frame', V(x * f, s * 0.08 * fy, -0.62 * f), X, Y, [0.38 * f, 1.08 * fy, 0.52 * f], { cavity: 0.35 });
    lite(fb, 'frame', V(x * f, -s * 0.62 * fy, -0.34 * f), X, Y, [0.35 * f, 0.5 * fy, 0.62 * f], { cavity: 0.45 });
  }
  // Thumb folded across the front of the fingers.
  const thumbDir = V(0.12, -s * 0.4, -1).normalize();
  lite(fb, 'frame', V(0.86 * f, -s * 0.36 * fy, -0.14 * f), thumbDir, X.clone().cross(thumbDir).normalize(), [0.9 * f, 0.42 * f, 0.36 * f], { cavity: 0.3 });
  // The plate: 6 mm AR500 across the knuckles, four raised ridges, four bolts, side straps.
  const z = -0.96 * f;
  lite(fb, 'mech', V(0, s * 0.08 * fy, z), X, Y, [1.94 * f, 1.36 * fy, 0.14 * f], { cavity: 0.15, edgeMin: 0.3 });
  for (const x of [-0.66, -0.22, 0.22, 0.66]) lite(fb, 'chrome', V(x * f, s * 0.1 * fy, z - 0.09 * f), X, Y, [0.32 * f, 1.02 * fy, 0.07 * f], { cavity: 0.1 });
  for (const x of [-0.86, 0.86]) for (const y of [-0.46, 0.62]) fb.bolt(V(x * f, s * y * fy, z - 0.075 * f), V(0, 0, -1), ctx.style.boltSize * 0.8, 'hex');
  for (const x of [-0.95, 0.95]) lite(fb, 'mech', V(x * f, s * 0.08 * fy, z + 0.45 * f), V(0, 0, 1), Y, [0.9 * f, 1.2 * fy, 0.08 * f], { cavity: 0.3 });
  // Wrist bearing where the forearm drive ends.
  fb.add('mech', collar(f * 0.36, f * 0.74, f * 0.72, f * 1.0, 20), undefined, { cavity: 0.3 });
  fb.add('frame', cylinder(f * 0.36, f * 0.7, f * 1.02, 14), undefined, { cavity: 0.5 });
}
