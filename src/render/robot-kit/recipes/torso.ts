// torso.chest and pelvis.block. The torso carries the gyro core (a finned rotor spinning behind
// a caged, glowing porthole), the neck collar, shoulder sockets, a backpack with exhaust stacks
// (the design's smoke point) and, on hydraulic designs, a reservoir with hoses to the arms.
import * as THREE from 'three/webgpu';
import { ensureAttributes, mergeKit, type DecalSpec } from '../geom/attrs';
import type { FrameBuilder } from '../geom/part-builder';
import { box, collar, cylinder, lathe } from '../geom/prims';
import { alongZ } from '../geom/xf';
import { DECAL } from '../types';
import { labelDecal, numberDecal, partPos, warningDecal } from './common';
import { housingRadius, isHydraulic, type RecipeContext } from './context';
import { actuator, block, cable, grille, hoseLine, slab, V, type Vec } from './mech';

const ROTOR_SPEED = 9; // rad/s, slow enough to read on screen
const CHEST_FLARE: Record<string, number> = { industrial: 1.14, sleek: 1.2, titan: 1.05 }; // top width / waist width
const GYRO_REF_KG = 14;

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

/** Slab facing `n`, with its length running along `down` projected onto the face plane. */
interface FacePlateOpts {
  taper?: number;
  accent?: string;
  decal?: DecalSpec;
  thick?: number;
  bolts?: 'corners' | 'edges' | 'none';
}

export function facePlate(ctx: RecipeContext, fb: FrameBuilder, center: Vec, n: Vec, lenDown: number, width: number, o: FacePlateOpts = {}): void {
  const nn = n.clone().normalize();
  // Plate length runs "down" the face; horizontal plates (tops, knuckles) run forward instead.
  const ref = Math.abs(nn.z) > 0.95 ? V(1, 0, 0) : V(0, 0, -1);
  const down = ref.addScaledVector(nn, -ref.dot(nn)).normalize();
  const v = new THREE.Vector3().crossVectors(nn, down);
  const thick = o.thick ?? ctx.style.plate;
  slab(fb, ctx.style, {
    center: center.clone().addScaledVector(nn, thick / 2), u: down, v, lenU: lenDown, lenV: width, thick, taper: o.taper,
    surf: { accent: !!o.accent && ctx.style.accents.has(o.accent), decal: o.decal }, bolts: o.bolts ?? 'edges',
  });
}

// ---------------------------------------------------------------- gyro core

/** Flywheel: hub, rim and swept fins, spinning about local +z. */
function rotorGeometry(R: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(ensureAttributes(lathe([[0, -0.012, 1], [R * 0.3, -0.012, 1], [R * 0.32, 0.0, 1], [R * 0.26, 0.014, 1], [0, 0.016, 1]], 28)));
  parts.push(ensureAttributes(collar(R * 0.86, R, -0.008, 0.008, 40)));
  const fins = 7;
  for (let k = 0; k < fins; k++) {
    const a = (k / fins) * Math.PI * 2;
    const g = box(R * 0.6, R * 0.065, 0.01, { bevel: 0.002, cell: 1 });
    const m = new THREE.Matrix4().makeRotationZ(a).multiply(new THREE.Matrix4().makeTranslation(R * 0.58, 0, 0)).multiply(new THREE.Matrix4().makeRotationX(0.45));
    parts.push(ensureAttributes(g.applyMatrix4(m)));
  }
  return mergeKit(parts);
}

/** Caged porthole set into the chest opening; `depth` is the room behind the plate face. */
function gyroPorthole(ctx: RecipeContext, center: Vec, Rg: number, depth: number): void {
  const fb = ctx.own;
  const d = V(1, 0, 0);
  const at = (dx: number) => center.clone().addScaledVector(d, dx);
  const back = -Math.max(0.02, depth);
  fb.add('mech', collar(Rg * 0.9, Rg * 1.34, -0.012, 0.016, 44), alongZ(center, d), { cavity: 0.25, edgeScale: 0.6 });
  fb.add('frame', collar(Rg * 0.86, Rg * 0.92, back, 0.0, 40), alongZ(center, d), { cavity: 0.9 });
  fb.boltRing(at(0.016), d, Rg * 1.12, 12, Math.min(ctx.style.boltSize, Rg * 0.07), 'hex', 0.1);
  fb.add('core', cylinder(Rg * 0.9, back - 0.004, back + 0.002, 44), alongZ(center, d));
  const pivot = new THREE.Group();
  pivot.position.copy(at(back * 0.45));
  pivot.quaternion.setFromUnitVectors(V(0, 0, 1), d);
  const rotor = new THREE.Mesh(rotorGeometry(Rg * 0.8), ctx.mats.mech);
  rotor.name = 'gyro-rotor';
  rotor.castShadow = false;
  pivot.add(rotor);
  fb.object(pivot);
  ctx.rotors.push({ object: rotor, axis: V(0, 0, 1), speed: ROTOR_SPEED });
  // Cage: radial bars and an inner ring across the opening.
  const bars = 6;
  for (let k = 0; k < bars; k++) {
    const a = (k / bars) * Math.PI * 2 + Math.PI / bars;
    const dir = V(0, Math.cos(a), Math.sin(a));
    const mid = at(0.002).addScaledVector(dir, Rg * 0.58);
    block(fb, 'frame', mid, dir, V(1, 0, 0).cross(dir).normalize(), [Rg * 0.66, Rg * 0.05, 0.012], { edgeMin: 0.3 });
  }
  fb.add('frame', collar(Rg * 0.2, Rg * 0.3, -0.004, 0.01, 24), alongZ(center, d), { edgeMin: 0.3 });
}

// ---------------------------------------------------------------- torso pieces

function waist(ctx: RecipeContext, t: TorsoBox): void {
  const pelvis = ctx.parentDims;
  const R = Math.min(t.hx, pelvis ? pelvis.size.y / 2 : t.hy) * 0.78;
  const [yawF, pitchF] = ctx.frames;
  if (yawF) {
    yawF.add('mech', collar(R * 0.5, R, -0.024, 0.012, 48), undefined, { cavity: 0.3 });
    yawF.boltRing(V(0, 0, 0.012), V(0, 0, 1), R * 0.78, 16, ctx.style.boltSize * 0.8, 'hex');
  }
  if (pitchF && ctx.frames.length > 2) {
    const Rp = housingRadius(ctx.part, 1) * 0.9;
    for (const s of [-1, 1]) actuator(pitchF, V(0, s, 0), V(0, s * t.hy * 0.42, 0.035), Rp, Rp * 0.8, ctx.style, { plainBack: true });
    pitchF.add('chrome', cylinder(Rp * 0.35, -t.hy * 0.42, t.hy * 0.42, 16), alongZ(V(0, 0, 0.035), V(0, 1, 0)));
  }
  // Abdomen: a rounded spine block bridging the waist bearing and the chest, with rib plates.
  const abdH = Math.max(0.06, t.z0 + 0.07);
  const abdZ = t.z0 + 0.035 - abdH / 2;
  block(ctx.own, 'frame', V(-t.hx * 0.08, 0, abdZ), V(1, 0, 0), V(0, 1, 0), [t.hx * 1.5, t.hy * 1.18, abdH], { cavity: 0.6 }, true);
  const ribs = 3;
  for (let k = 0; k < ribs; k++) {
    const z = abdZ - abdH * 0.3 + (abdH * 0.6 * k) / (ribs - 1);
    block(ctx.own, 'mech', V(t.hx * 0.66, 0, z), V(0, 1, 0), V(0, 0, 1), [t.hy * 0.9, abdH * 0.16, 0.014], { cavity: 0.4 });
  }
}

interface Porthole {
  center: Vec;
  R: number; // opening radius
}

/** Central chest plate: one tapered slab, or four slabs framing the gyro opening. */
function chestPlate(ctx: RecipeContext, t: TorsoBox, frontX: number, width: number, hole: Porthole | null): void {
  const fb = ctx.own;
  const zb = t.z0 + t.H * 0.5;
  const zt = t.z0 + t.H * 0.96;
  if (!hole) {
    facePlate(ctx, fb, V(frontX, 0, (zb + zt) / 2), V(1, 0, 0.12), zt - zb, width, { taper: 0.82, decal: numberDecal('x') });
    return;
  }
  const { R } = hole;
  const cz = hole.center.z;
  const put = (za: number, zc: number, y: number, w: number, bolts: 'corners' | 'edges' | 'none') => {
    if (za - zc < 0.02 || w < 0.02) return;
    facePlate(ctx, fb, V(frontX, y, (za + zc) / 2), V(1, 0, 0), za - zc, w, { bolts });
  };
  put(zt, Math.min(zt, cz + R), 0, width, 'edges');
  put(Math.max(zb, cz - R), zb, 0, width, 'corners');
  const sideW = width / 2 - R;
  for (const s of [-1, 1]) put(Math.min(zt, cz + R), Math.max(zb, cz - R), s * (R + sideW / 2), sideW, 'none');
}

function chestArmor(ctx: RecipeContext, t: TorsoBox, hole: Porthole | null): void {
  const { hx, hy, z0, H } = t;
  const fb = ctx.own;
  const style = ctx.style;
  const round = style.round;
  // Structural core, slightly inside the collision box so the plates sit proud of it. It flares
  // toward the shoulders: a V for fighters, a barrel for the titan.
  const flare = CHEST_FLARE[style.id];
  fb.add('frame', box(hx * 1.62, hy * 1.72 / flare, H * 0.9, { bevel: 0.03, round, cell: 0.06, taper: flare, taperAxes: 'y' }), new THREE.Matrix4().makeTranslation(-hx * 0.12, 0, z0 + H * 0.5), { cavity: 0.55 });
  const chestW = style.id === 'titan' ? hy * 1.45 : style.id === 'sleek' ? hy * 1.05 : hy * 1.25;
  chestPlate(ctx, t, hx * 0.84, chestW, hole);
  // Pectorals, angled outward and up.
  for (const s of [-1, 1]) {
    const n = V(1, s * 0.5, 0.28);
    facePlate(ctx, fb, V(hx * 0.72, s * hy * 0.66, z0 + H * 0.76), n, H * 0.36, hy * 0.62, { accent: 'chest.pec', taper: 0.85, bolts: 'corners' });
  }
  // Segmented abdomen plates, each tucked under the one above.
  const segs = style.id === 'sleek' ? 2 : 3;
  for (let k = 0; k < segs; k++) {
    const z = z0 + H * (0.43 - k * 0.13);
    const w = hy * (1.15 - k * 0.12);
    facePlate(ctx, fb, V(hx * (0.86 - k * 0.04), 0, z), V(1, 0, -0.18), H * 0.12, w, { bolts: 'corners', thick: style.plate * 0.9 });
  }
  // Flank plates with the design's label.
  for (const s of [-1, 1]) {
    const decal = s > 0 ? labelDecal('y', [0.08, 0.2, 0.92, 0.8]) : labelDecal('-y', [0.08, 0.2, 0.92, 0.8]);
    const lean = (CHEST_FLARE[style.id] - 1) * 0.9;
    facePlate(ctx, fb, V(-hx * 0.05, s * hy * 0.84, z0 + H * 0.36), V(0, s, -lean), H * 0.4, hx * 1.35, { decal, bolts: 'edges' });
  }
}

function neckCollar(ctx: RecipeContext, t: TorsoBox): void {
  const neck = partPos(ctx, 'head');
  if (!neck) return;
  const fb = ctx.own;
  const r = Math.min(t.hx, t.hy) * 0.42;
  const tall = ctx.style.id === 'titan' ? 0.045 : 0.025;
  fb.add(ctx.style.id === 'titan' ? 'paint' : 'frame', collar(r, r * 1.45, t.z1 - 0.03, neck.z + tall, 40), new THREE.Matrix4().makeTranslation(neck.x, neck.y, 0), { cavity: 0.3 });
  // Trapezius plates sloping from the collar to the shoulders.
  for (const s of [-1, 1]) {
    const n = V(0.1, s * 0.55, 1);
    facePlate(ctx, fb, V(-t.hx * 0.05, s * t.hy * 0.55, t.z1 - 0.012), n, t.hx * 1.4, t.hy * 0.62, { bolts: 'corners', thick: ctx.style.plate * 1.1 });
  }
}

function shoulderSockets(ctx: RecipeContext, t: TorsoBox): void {
  for (const id of ['upperarm_l', 'upperarm_r']) {
    const p = partPos(ctx, id);
    const arm = ctx.design.parts.find((q) => q.id === id);
    if (!p || !arm) continue;
    const s = Math.sign(p.y) || 1;
    const R = housingRadius(arm, 0) * 1.25;
    ctx.own.add('frame', cylinder(R, t.hy - 0.03, t.hy + 0.008, 32, 0.008), alongZ(V(p.x, 0, p.z), V(0, s, 0)), { cavity: 0.4 });
    ctx.own.boltRing(V(p.x, s * (t.hy + 0.008), p.z), V(0, s, 0), R * 0.82, 8, ctx.style.boltSize * 0.8, 'hex');
  }
}

function backpack(ctx: RecipeContext, t: TorsoBox): void {
  const fb = ctx.own;
  const { hx, hy, z0, H } = t;
  const back = -hx * 0.74;
  const depth = hx * 0.36;
  const cx = back - depth / 2;
  const cz = z0 + H * 0.56;
  fb.add('frame', box(depth, hy * 1.25, H * 0.62, { bevel: 0.018, round: ctx.style.round, cell: 0.06 }), new THREE.Matrix4().makeTranslation(cx, 0, cz), { cavity: 0.45 });
  facePlate(ctx, fb, V(back - depth, 0, cz + H * 0.08), V(-1, 0, 0), H * 0.34, hy * 1.05, { decal: warningDecal('-x'), bolts: 'edges' });
  grille(fb, V(back - depth - 0.004, 0, cz - H * 0.2), V(0, 1, 0), V(-1, 0, 0), hy * 0.9, H * 0.14, 5, 0.02);
  // Exhaust stacks by the smoke point.
  const smoke = ctx.part.smokePoint;
  const sz = smoke ? smoke[2] : z0 + H * 0.85;
  for (const s of [-1, 1]) {
    const base = V(cx, s * hy * 0.32, Math.min(sz, t.z1 - 0.05));
    fb.add('mech', lathe([[0, 0, 1], [0.03, 0, 1], [0.03, 0.035, 0], [0.026, 0.06, 1], [0.028, 0.07, 1], [0.022, 0.07, 1], [0.022, 0.02, 1], [0, 0.02, 1]], 20), alongZ(base, V(-0.45, 0, 1)), { edgeMin: 0.2, cavity: 0.5 });
  }
  if (ctx.design.hydraulics?.length) {
    // Reservoir tank along y on top of the pack, with a pressure gauge.
    const tank = V(cx, 0, t.z1 - 0.035);
    fb.add('paint', lathe([[0, -hy * 0.5, 1], [0.03, -hy * 0.5, 1], [0.04, -hy * 0.47, 0], [0.042, -hy * 0.42, 1], [0.042, hy * 0.42, 1], [0.04, hy * 0.47, 0], [0.03, hy * 0.5, 1], [0, hy * 0.5, 1]], 28), alongZ(tank, V(0, 1, 0)), { cavity: 0.2 });
    for (const s of [-1, 1]) fb.add('mech', collar(0.036, 0.046, -0.008, 0.008, 28), alongZ(tank.clone().setY(s * hy * 0.38), V(0, 1, 0)));
    fb.add('mech', cylinder(0.018, 0, 0.012, 20), alongZ(tank.clone().add(V(-0.04, hy * 0.15, 0)), V(-1, 0, 0.3)));
    fb.add('lens', cylinder(0.014, 0.011, 0.014, 20), alongZ(tank.clone().add(V(-0.04, hy * 0.15, 0)), V(-1, 0, 0.3)));
  }
}

function torsoCabling(ctx: RecipeContext, t: TorsoBox): void {
  const fb = ctx.own;
  const { hx, hy, z0, z1 } = t;
  const back = -hx * 0.74;
  // Spine cables from the backpack into the waist.
  for (let i = 0; i < 3; i++) {
    const y = (i - 1) * 0.022;
    cable(fb, [V(back - 0.01, y, z0 + 0.1), V(back + 0.005, y * 1.4, z0 + 0.03), V(-hx * 0.3, y * 1.6, 0.0), V(-hx * 0.1, y, -0.03)], 0.009, i === 1 ? ctx.style.signal : ctx.style.cable);
  }
  if (ctx.style.hoses) {
    for (const s of [-1, 1]) {
      hoseLine(fb, [V(-hx * 0.4, s * hy * 0.4, z1 - 0.02), V(-hx * 0.1, s * hy * 0.8, z1 + 0.012), V(hx * 0.2, s * hy * 0.95, z1 - 0.04)], 0.0105, ctx.style.hose);
    }
  }
}

/** Hydraulic hoses from the backpack over each shoulder to the upper arm. */
function armHoses(ctx: RecipeContext, t: TorsoBox): void {
  if (!ctx.design.hydraulics?.length || !ctx.style.hoses) return;
  for (const id of ['upperarm_l', 'upperarm_r']) {
    const arm = ctx.design.parts.find((q) => q.id === id);
    const forearm = ctx.design.parts.find((q) => q.parent === id);
    if (!arm || !forearm || !isHydraulic(forearm)) continue;
    const s = Math.sign(arm.pos[1]) || 1;
    const r = arm.geoms[0]?.shape.type === 'capsule' ? arm.geoms[0].shape.radius : 0.08;
    ctx.linkages.push({
      kind: 'hose', parent: 'torso', child: id, radius: 0.011, color: ctx.style.hose, slack: 0.45,
      a: V(-t.hx * 0.85, s * t.hy * 0.62, t.z1 - 0.05), aDir: V(0.2, s * 0.6, 0.7),
      b: V(-r * 1.05, 0, -0.09), bDir: V(0.1, 0, -1),
    });
  }
}

export function torsoRecipe(ctx: RecipeContext): void {
  const t = torsoBox(ctx);
  let hole: Porthole | null = null;
  if (ctx.design.gyro || ctx.params.gyro === true) {
    const mass = ctx.design.gyro?.massKg ?? GYRO_REF_KG;
    const R = THREE.MathUtils.clamp(0.36 * Math.min(t.hy, t.H / 2) * Math.cbrt(mass / GYRO_REF_KG), 0.06, 0.16);
    hole = { center: V(t.hx * 0.84 + ctx.style.plate, 0, t.z0 + t.H * 0.68), R };
  }
  waist(ctx, t);
  chestArmor(ctx, t, hole);
  neckCollar(ctx, t);
  shoulderSockets(ctx, t);
  backpack(ctx, t);
  torsoCabling(ctx, t);
  armHoses(ctx, t);
  if (hole) {
    const coreFront = -t.hx * 0.12 + t.hx * 0.81;
    gyroPorthole(ctx, hole.center, hole.R, hole.center.x - coreFront - 0.006);
  }
}

// ---------------------------------------------------------------- pelvis

export function pelvisRecipe(ctx: RecipeContext): void {
  const d = ctx.dims;
  const hx = d.size.x / 2;
  const hy = d.size.y / 2;
  const hz = d.size.z / 2;
  const fb = ctx.own;
  fb.add('frame', box(hx * 1.7, hy * 1.62, hz * 1.7, { bevel: 0.02, round: ctx.style.round, cell: 0.05 }), undefined, { cavity: 0.5 });
  // Codpiece and back plate.
  facePlate(ctx, fb, V(hx * 0.85, 0, -hz * 0.08), V(1, 0, -0.1), hz * 1.72, hy * 0.95, { taper: 0.62, decal: { kind: DECAL.SERIAL, axis: 'x', rect: [0.15, 0.35, 0.85, 0.75] } });
  facePlate(ctx, fb, V(-hx * 0.85, 0, 0), V(-1, 0, 0), hz * 1.7, hy * 1.2, { bolts: 'edges' });
  // Hip tassets hanging over the hip joints.
  for (const s of [-1, 1]) {
    facePlate(ctx, fb, V(hx * 0.1, s * hy * 0.8, -hz * 0.22), V(0, s, 0.22), hz * 1.8, hx * 1.55, { bolts: 'corners', taper: 0.85 });
  }
  // Belt band.
  for (const s of [-1, 1]) block(fb, 'mech', V(0, s * hy * 0.8, hz * 0.72), V(1, 0, 0), V(0, 0, 1), [hx * 1.75, hz * 0.28, 0.012], { cavity: 0.3 });
  cable(fb, [V(-hx * 0.8, hy * 0.3, hz * 0.6), V(-hx * 0.95, hy * 0.5, -hz * 0.2), V(-hx * 0.4, hy * 0.62, -hz * 0.95)], 0.008, ctx.style.cable);
  cable(fb, [V(-hx * 0.8, -hy * 0.3, hz * 0.6), V(-hx * 0.95, -hy * 0.5, -hz * 0.2), V(-hx * 0.4, -hy * 0.62, -hz * 0.95)], 0.008, ctx.style.signal);
}
