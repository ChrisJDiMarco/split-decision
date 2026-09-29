// Damage visuals. applyImpact dents the part's meshes around the contact (vertex displacement
// with analytically tilted normals, so shading reads the dent) and writes scratch / scorch into
// aDamage for the shader. setPartState drives heat glow and wear, and swaps a detached part
// for its debris twin while a torn socket appears on the parent.
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../../core/types';
import { MATERIALS } from '../../../robots/catalog';
import type { KitPart, PartVisualState, RobotKitView } from '../types';
import { noteHit } from '../eyes';
import { buildStump } from './stump';

const MIN_VISIBLE_J = 0.5; // below this an impact leaves no mark (skips a buffer upload)
const MIN_DENT_J = 3; // below this an impact only scuffs
const DEPTH_K = 0.009; // metres per sqrt(J/10) at the reference hardness (exaggerated for readability)
const MAX_DEPTH_M = 0.045;
const RADIUS_K = 0.022; // metres per cbrt(J/10)
const MIN_RADIUS_M = 0.02;
const MAX_RADIUS_M = 0.11;
const SCRATCH_REACH = 1.7; // scratches extend past the dent
const SCORCH_J = 450; // energy for full scorch at the centre
const REF_BRINELL = 180;

const tmpP = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const inv = new THREE.Matrix4();
const nrmMat = new THREE.Matrix3();

function toV(v: Vec3 | THREE.Vector3): THREE.Vector3 {
  return Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
}

/** Softness of the part's armor: dents run deeper in aluminium than in AR500. */
function softness(kit: KitPart): number {
  const mat = kit.def.geoms[0]?.material;
  const brinell = mat ? MATERIALS[mat].brinell : REF_BRINELL;
  return THREE.MathUtils.clamp(REF_BRINELL / Math.max(brinell, 1), 0.35, 2.2);
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

interface Dent {
  center: THREE.Vector3; // local
  dir: THREE.Vector3; // local, outward
  depth: number;
  radius: number;
  scorch: number;
}

/** Displace one mesh's vertices around the dent and record scratch / scorch / dent memory. */
function dentMesh(mesh: THREE.Mesh, d: Dent): void {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const dmg = geo.getAttribute('aDamage') as THREE.BufferAttribute | undefined;
  const reach = d.radius * SCRATCH_REACH;
  const R2 = d.radius * d.radius;
  const radial = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmpP.fromBufferAttribute(pos, i);
    const dist = tmpP.distanceTo(d.center);
    if (dist > reach) continue;
    if (dmg) {
      const s = 1 - dist / reach;
      const scorch = d.scorch * Math.max(0, 1 - dist / (d.radius * 0.9));
      dmg.setX(i, Math.min(1, dmg.getX(i) + s * 0.9));
      dmg.setY(i, Math.min(1, dmg.getY(i) + scorch));
    }
    if (dist * dist >= R2) continue;
    const x = dist / d.radius;
    const f = (1 - x * x) * (1 - x * x);
    const crumple = 0.7 + 0.6 * hash3(tmpP.x * 91, tmpP.y * 91, tmpP.z * 91);
    const disp = d.depth * f * crumple;
    pos.setXYZ(i, tmpP.x - d.dir.x * disp, tmpP.y - d.dir.y * disp, tmpP.z - d.dir.z * disp);
    // Tilt the normal toward the dent centre by the slope of the dent profile.
    tmpN.fromBufferAttribute(nor, i);
    radial.subVectors(tmpP, d.center).addScaledVector(tmpN, -radial.dot(tmpN));
    const rl = radial.length();
    if (rl > 1e-6) {
      // Front faces see a crater (tilt inward); faces looking away see a bulge (tilt outward).
      const facing = tmpN.dot(d.dir) >= 0 ? 1 : -1;
      const slope = (4 * d.depth * x * (1 - x * x)) / d.radius;
      tmpN.addScaledVector(radial.divideScalar(rl), -slope * crumple * facing).normalize();
      nor.setXYZ(i, tmpN.x, tmpN.y, tmpN.z);
    }
    if (dmg) dmg.setZ(i, Math.min(1, Math.max(dmg.getZ(i), f * (d.depth / 0.012))));
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  if (dmg) dmg.needsUpdate = true;
}

const instM = new THREE.Matrix4();
const instP = new THREE.Vector3();
const instQ = new THREE.Quaternion();
const instS = new THREE.Vector3();

function dentBolts(inst: THREE.InstancedMesh, d: Dent): void {
  let moved = false;
  for (let i = 0; i < inst.count; i++) {
    inst.getMatrixAt(i, instM);
    instM.decompose(instP, instQ, instS);
    const dist = instP.distanceTo(d.center);
    if (dist >= d.radius) continue;
    const x = dist / d.radius;
    instP.addScaledVector(d.dir, -d.depth * (1 - x * x) * (1 - x * x));
    inst.setMatrixAt(i, instM.compose(instP, instQ, instS));
    moved = true;
  }
  if (moved) inst.instanceMatrix.needsUpdate = true;
}

/** Structural slots dent; optics, glass and glowing cores would crack instead, so they don't. */
const DENTABLE = new Set<string>(['paint', 'trim', 'glove', 'frame', 'mech', 'chrome', 'rubber', 'wire']);

function dentable(o: THREE.Object3D): boolean {
  return (o as THREE.Mesh).isMesh && DENTABLE.has(o.userData.slot as string);
}

/** Every dentable mesh of the part: its own content plus its joint-frame housings. */
function partMeshes(kit: KitPart): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const root = kit.state.attached ? kit.content : kit.debrisContent;
  root?.traverse((o) => {
    if (dentable(o)) out.push(o);
  });
  if (kit.state.attached) for (const f of kit.frames) for (const c of f.group.children) if (dentable(c)) out.push(c);
  return out;
}

/**
 * Dent and mark a part. `worldPoint` and `normal` are in scene space (the three.js world, not
 * the physics frame); energy in joules. The normal may point either way; it is flipped to
 * face out of the part.
 */
export function applyImpact(view: RobotKitView, partId: string, worldPoint: Vec3 | THREE.Vector3, normal: Vec3 | THREE.Vector3, energyJ: number): void {
  const kit = view.parts.get(partId);
  if (!kit || !(energyJ >= MIN_VISIBLE_J)) return;
  noteHit(view, partId, energyJ);
  const soft = softness(kit);
  const e10 = energyJ / 10;
  const depth = energyJ < MIN_DENT_J ? 0 : Math.min(MAX_DEPTH_M, DEPTH_K * Math.sqrt(e10) * soft);
  const radius = THREE.MathUtils.clamp(RADIUS_K * Math.cbrt(e10), MIN_RADIUS_M, MAX_RADIUS_M);
  const scorch = Math.min(1, energyJ / SCORCH_J);
  const wp = toV(worldPoint);
  const wn = toV(normal).normalize();
  const host = kit.state.attached ? kit.attached : kit.debris;
  if (!host) return;
  host.updateWorldMatrix(true, true);
  const centreW = new THREE.Box3().setFromObject(kit.state.attached ? kit.content : (kit.debrisContent ?? kit.content)).getCenter(new THREE.Vector3());
  if (wn.dot(wp.clone().sub(centreW)) < 0) wn.negate();
  for (const o of partMeshes(kit)) {
    o.updateWorldMatrix(true, false);
    inv.copy(o.matrixWorld).invert();
    const center = wp.clone().applyMatrix4(inv);
    nrmMat.getNormalMatrix(inv);
    const dir = wn.clone().applyMatrix3(nrmMat).normalize();
    const d: Dent = { center, dir, depth, radius, scorch };
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) dentBolts(inst, d);
    else dentMesh(o as THREE.Mesh, d);
  }
  kit.obj.wear = Math.min(1, kit.obj.wear + energyJ / 4000);
  if (kit.debrisObj) kit.debrisObj.wear = kit.obj.wear;
}

// ---------------------------------------------------------------- state and detach

/** Direction the part extends from its joint, in the part frame (for stump orientation). */
function outward(kit: KitPart): THREE.Vector3 {
  const box = new THREE.Box3();
  kit.content.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!);
  });
  const c = box.isEmpty() ? new THREE.Vector3(0, 0, 1) : box.getCenter(new THREE.Vector3());
  return c.lengthSq() < 1e-8 ? new THREE.Vector3(0, 0, 1) : c.normalize();
}

function socketRadius(kit: KitPart): number {
  const s = new THREE.Box3().setFromObject(kit.content).getSize(new THREE.Vector3());
  return THREE.MathUtils.clamp(Math.min(s.x, s.y, s.z) * 0.45, 0.03, 0.12);
}

function detach(view: RobotKitView, kit: KitPart): void {
  kit.content.visible = false;
  for (let k = 1; k < kit.frames.length; k++) kit.frames[k].group.visible = false;
  if (kit.debris) kit.debris.visible = true;
  kit.detachedAt = view.time;
  const dir = outward(kit);
  const r = socketRadius(kit);
  const seed = Math.floor(kit.obj.seed * 1e6);
  const host = kit.frames[0]?.group ?? view.parts.get(kit.def.parent ?? '')?.attached;
  // Only the part that broke off (it has a debris twin) leaves a torn socket. A rigid part carried
  // away on its parent's debris just hides; a stump would hang where the parent used to be.
  if (host && !kit.stump && kit.debris) {
    const stump = buildStump(view.materials, dir, r, seed, `${kit.id}:stump`);
    if (!kit.frames[0]) stump.group.position.set(...kit.def.pos);
    host.add(stump.group);
    kit.stump = stump.group;
    kit.stumpObj = stump.obj;
    kit.sparkPoints = stump.sparks;
  }
  if (kit.debris && kit.debrisObj && !kit.debris.getObjectByName(`${kit.id}:torn`)) {
    const torn = buildStump(view.materials, dir.clone().negate(), r * 0.8, seed + 17, `${kit.id}:torn`);
    torn.group.name = `${kit.id}:torn`;
    torn.obj.glow = 0;
    kit.debris.add(torn.group);
  }
}

function reattach(kit: KitPart): void {
  kit.content.visible = true;
  for (const f of kit.frames) f.group.visible = true;
  if (kit.debris) kit.debris.visible = false;
  kit.stump?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
  });
  kit.stump?.removeFromParent();
  kit.stump = null;
  kit.stumpObj = null;
  kit.sparkPoints = [];
  kit.detachedAt = -1;
}

export function setPartState(view: RobotKitView, partId: string, s: Partial<PartVisualState>): void {
  const kit = view.parts.get(partId);
  if (!kit) return;
  if (s.hp !== undefined) {
    kit.state.hp = s.hp;
    kit.obj.wear = Math.max(kit.obj.wear, 1 - s.hp);
    if (kit.debrisObj) kit.debrisObj.wear = kit.obj.wear;
  }
  if (s.heat !== undefined) {
    kit.state.heat = s.heat;
    kit.obj.heat = s.heat;
    if (kit.debrisObj) kit.debrisObj.heat = s.heat;
  }
  if (s.attached !== undefined && s.attached !== kit.state.attached) {
    kit.state.attached = s.attached;
    if (s.attached) reattach(kit);
    else detach(view, kit);
  }
}

/** World positions of every live spark point (torn wires), for the VFX layer. */
export function sparkPoints(view: RobotKitView): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const kit of view.parts.values()) {
    for (const s of kit.sparkPoints) {
      s.updateWorldMatrix(true, false);
      out.push(new THREE.Vector3().setFromMatrixPosition(s.matrixWorld));
    }
  }
  return out;
}

/** A point given in a part's frame, in world space (vents, leak points, anchors). */
export function partPointWorld(view: RobotKitView, partId: string, local: Vec3 | THREE.Vector3): THREE.Vector3 | null {
  const kit = view.parts.get(partId);
  const host = kit ? (kit.state.attached ? kit.attached : kit.debris) : null;
  if (!host) return null;
  host.updateWorldMatrix(true, false);
  return toV(local).applyMatrix4(host.matrixWorld);
}

export interface KitAnchor {
  part: string;
  name: string; // e.g. 'leak.pistonL', 'leak.wristR', 'leak.calf', 'vent'
  pos: THREE.Vector3; // scene space
}

/**
 * Named anchor points in scene space: hydraulic seals and lines ('leak.*') for the oil
 * emitter, smoke vents ('vent') for smoke. Detached parts report from their debris twin.
 */
export function anchorPointsWorld(view: RobotKitView, prefix = ''): KitAnchor[] {
  const out: KitAnchor[] = [];
  for (const kit of view.parts.values()) {
    const host = kit.state.attached ? kit.attached : kit.debris;
    if (!host) continue;
    host.updateWorldMatrix(true, false);
    for (const [name, p] of kit.anchors) {
      if (!name.startsWith(prefix)) continue;
      out.push({ part: kit.id, name, pos: p.clone().applyMatrix4(host.matrixWorld) });
    }
  }
  return out;
}
