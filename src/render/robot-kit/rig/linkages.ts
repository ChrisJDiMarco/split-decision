// Linkages that span two bodies: hydraulic pistons (barrel pivots on the parent, rod eye pinned
// to the child) and flexible hoses (a Bezier re-shaped every frame). Both live under the
// parent's body group and read the child's pose relative to it.
import * as THREE from 'three/webgpu';
import { ensureAttributes } from '../geom/attrs';
import { newObjState } from '../geom/part-builder';
import { collar, cylinder } from '../geom/prims';
import type { LinkageRequest } from '../recipes/context';
import type { HoseLinkage, KitMaterials, Linkage, PistonLinkage } from '../types';
import { quatZTo } from '../geom/xf';
import { relativePose } from './joints';

const HOSE_SEGMENTS = 14;
const HOSE_RADIAL = 7;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(ensureAttributes(geo), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function buildPiston(req: Extract<LinkageRequest, { kind: 'piston' }>, mats: KitMaterials, host: THREE.Object3D): PistonLinkage {
  const r = req.radius;
  const L = req.barrelLength;
  const state = newObjState(0.5);
  const barrel = new THREE.Group();
  barrel.name = `piston-barrel:${req.child}`;
  // Pivot eye, barrel tube, end caps and gland nut.
  barrel.add(mesh(collar(r * 0.45, r * 1.05, -r * 0.7, r * 0.7, 18).rotateX(Math.PI / 2), mats.mech));
  barrel.add(mesh(cylinder(r, r * 0.6, L, 22, r * 0.2), mats.frame));
  barrel.add(mesh(cylinder(r * 1.18, r * 0.6, r * 1.3, 22, r * 0.15), mats.mech));
  barrel.add(mesh(cylinder(r * 1.22, L - r * 0.9, L, 8, r * 0.15), mats.mech));
  const rod = new THREE.Group();
  rod.name = `piston-rod:${req.child}`;
  rod.add(mesh(cylinder(r * 0.48, r * 0.5, L * 0.95, 16, r * 0.1), mats.chrome));
  rod.add(mesh(collar(r * 0.35, r * 0.8, -r * 0.55, r * 0.55, 16).rotateX(Math.PI / 2), mats.mech));
  for (const o of [barrel, rod]) {
    o.traverse((c) => {
      c.userData.kit = state;
    });
    host.add(o);
  }
  return { kind: 'piston', parent: req.parent, child: req.child, anchorParent: req.anchorParent.clone(), anchorChild: req.anchorChild.clone(), barrel, rod, barrelLength: L };
}

function hoseGeometry(color: THREE.Color): THREE.BufferGeometry {
  const rings = HOSE_SEGMENTS + 1;
  const count = rings * (HOSE_RADIAL + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) col.set([color.r, color.g, color.b], i * 3);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const idx: number[] = [];
  for (let s = 0; s < HOSE_SEGMENTS; s++) {
    for (let k = 0; k < HOSE_RADIAL; k++) {
      const a = s * (HOSE_RADIAL + 1) + k;
      const b = a + HOSE_RADIAL + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geo.setIndex(idx);
  ensureAttributes(geo);
  (geo.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geo.getAttribute('normal') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  return geo;
}

function buildHose(req: Extract<LinkageRequest, { kind: 'hose' }>, mats: KitMaterials, host: THREE.Object3D): HoseLinkage {
  const m = mesh(hoseGeometry(new THREE.Color(req.color)), mats.rubber);
  m.name = `hose:${req.parent}-${req.child}`;
  m.frustumCulled = false;
  m.userData.kit = newObjState(0.3);
  host.add(m);
  return { kind: 'hose', parent: req.parent, child: req.child, a: req.a.clone(), aDir: req.aDir.clone().normalize(), b: req.b.clone(), bDir: req.bDir.clone().normalize(), mesh: m, radius: req.radius, slack: req.slack };
}

export function buildLinkage(req: LinkageRequest, mats: KitMaterials, host: THREE.Object3D): Linkage {
  return req.kind === 'piston' ? buildPiston(req, mats, host) : buildHose(req, mats, host);
}

// ---------------------------------------------------------------- per-frame update

const relPos = new THREE.Vector3();
const relQuat = new THREE.Quaternion();
const tmpB = new THREE.Vector3();
const dir = new THREE.Vector3();

function updatePiston(l: PistonLinkage, parent: THREE.Object3D, child: THREE.Object3D): void {
  relativePose(parent, child, relPos, relQuat);
  tmpB.copy(l.anchorChild).applyQuaternion(relQuat).add(relPos);
  dir.subVectors(tmpB, l.anchorParent);
  if (dir.lengthSq() < 1e-10) return;
  l.barrel.position.copy(l.anchorParent);
  l.barrel.quaternion.copy(quatZTo(dir));
  l.rod.position.copy(tmpB);
  l.rod.quaternion.copy(quatZTo(dir.negate()));
}

const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();
const pt = new THREE.Vector3();
const tan = new THREE.Vector3();
const nrm = new THREE.Vector3();
const bin = new THREE.Vector3();
const prevN = new THREE.Vector3();

function bezier(t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  return out.set(0, 0, 0).addScaledVector(P0, u * u * u).addScaledVector(P1, 3 * u * u * t).addScaledVector(P2, 3 * u * t * t).addScaledVector(P3, t * t * t);
}

function bezierTangent(t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  // d/dt of the cubic, expanded so no temporaries are allocated per ring.
  const a = -3 * u * u;
  const b = 3 * u * u - 6 * u * t;
  const c = 6 * u * t - 3 * t * t;
  const d = 3 * t * t;
  out.set(0, 0, 0).addScaledVector(P0, a).addScaledVector(P1, b).addScaledVector(P2, c).addScaledVector(P3, d);
  return out.normalize();
}

function updateHose(l: HoseLinkage, parent: THREE.Object3D, child: THREE.Object3D): void {
  relativePose(parent, child, relPos, relQuat);
  P0.copy(l.a);
  P3.copy(l.b).applyQuaternion(relQuat).add(relPos);
  const span = P0.distanceTo(P3) * l.slack + 0.02;
  P1.copy(P0).addScaledVector(l.aDir, span);
  P2.copy(P3).addScaledVector(dir.copy(l.bDir).applyQuaternion(relQuat), -span);
  const geo = l.mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  bezierTangent(0, tan);
  prevN.set(0, 0, 1).cross(tan);
  if (prevN.lengthSq() < 1e-6) prevN.set(1, 0, 0).cross(tan);
  prevN.normalize();
  let v = 0;
  for (let s = 0; s <= HOSE_SEGMENTS; s++) {
    const t = s / HOSE_SEGMENTS;
    bezier(t, pt);
    bezierTangent(t, tan);
    // Parallel transport keeps the ring frame from twisting.
    bin.crossVectors(tan, prevN).normalize();
    nrm.crossVectors(bin, tan).normalize();
    prevN.copy(nrm);
    for (let k = 0; k <= HOSE_RADIAL; k++) {
      const a = (k / HOSE_RADIAL) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const nx = nrm.x * c + bin.x * sn;
      const ny = nrm.y * c + bin.y * sn;
      const nz = nrm.z * c + bin.z * sn;
      pos.setXYZ(v, pt.x + nx * l.radius, pt.y + ny * l.radius, pt.z + nz * l.radius);
      nor.setXYZ(v, nx, ny, nz);
      v++;
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

export function updateLinkage(l: Linkage, parent: THREE.Object3D, child: THREE.Object3D): void {
  if (l.kind === 'piston') updatePiston(l, parent, child);
  else updateHose(l, parent, child);
}
