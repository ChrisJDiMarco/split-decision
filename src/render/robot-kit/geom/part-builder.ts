// Collects a frame's geometry per material slot, plus instanced fasteners and named anchors,
// then merges everything into one mesh per slot. A "frame" is either a part's own body frame
// or one of its joint frames (see rig/joints.ts).
import * as THREE from 'three/webgpu';
import { MAT_SLOTS, type KitMaterials, type MatSlot } from '../types';
import { applySurf, ensureAttributes, indexed, mergeKit, triangleCount, type SurfOpts } from './attrs';
import { hexBoltGeometry, rivetGeometry } from './prims';
import { rng } from './xf';

export type BoltKind = 'hex' | 'rivet';

/** Per-object values read by the kit materials through `onObjectUpdate` uniforms. */
export interface KitObjState {
  heat: number; // 0..1 glow of hot metal
  wear: number; // 0..1 extra scratches and grime (1 - hp)
  glow: number; // eye / LED intensity multiplier
  core: number; // gyro core glow 0..1+
  seed: number; // per-part variation 0..1
  flash: number; // optics: 0..1 mix toward white (hit flash, lock-on core)
  tint: number; // optics: 0..1 mix toward hot red (badly hurt)
}

export function newObjState(seed: number): KitObjState {
  return { heat: 0, wear: 0, glow: 1, core: 0.3, seed, flash: 0, tint: 0 };
}

export interface BuiltFrame {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  bolts: THREE.InstancedMesh[];
  triangles: number;
}

let boltGeos: Record<BoltKind, THREE.BufferGeometry> | null = null;

/** Shared unit fastener geometries (never disposed; they are tiny and reused by every robot). */
export function sharedBoltGeometries(): Record<BoltKind, THREE.BufferGeometry> {
  boltGeos ??= { hex: ensureAttributes(hexBoltGeometry()), rivet: ensureAttributes(rivetGeometry()) };
  return boltGeos;
}

const Z = new THREE.Vector3(0, 0, 1);

function flipWinding(geo: THREE.BufferGeometry): void {
  const idx = geo.index;
  if (!idx) return;
  for (let i = 0; i < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
}

export class FrameBuilder {
  private readonly geos = new Map<MatSlot, THREE.BufferGeometry[]>();
  private readonly boltMats: Record<BoltKind, THREE.Matrix4[]> = { hex: [], rivet: [] };
  readonly objects: THREE.Object3D[] = [];
  readonly anchors = new Map<string, THREE.Vector3>();
  readonly random: () => number;

  constructor(readonly name: string, seed: number) {
    this.random = rng(seed);
  }

  /** Add a generated geometry (consumed) placed by `m` (mirroring matrices are fine). */
  add(slot: MatSlot, geo: THREE.BufferGeometry, m?: THREE.Matrix4, surf: SurfOpts = {}): this {
    const g = indexed(geo);
    if (m) {
      g.applyMatrix4(m);
      if (m.determinant() < 0) flipWinding(g);
    }
    ensureAttributes(g);
    // Every added piece gets its own variant, so patchwork skins colour plates independently.
    applySurf(g, { variant: this.random(), ...surf });
    const list = this.geos.get(slot) ?? [];
    list.push(g);
    this.geos.set(slot, list);
    return this;
  }

  /** One fastener on a surface point, head along `normal`, `size` = head radius in metres. */
  bolt(pos: THREE.Vector3, normal: THREE.Vector3, size: number, kind: BoltKind = 'hex'): this {
    const q = new THREE.Quaternion().setFromUnitVectors(Z, normal.clone().normalize());
    q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, this.random() * Math.PI));
    this.boltMats[kind].push(new THREE.Matrix4().compose(pos.clone(), q, new THREE.Vector3(size, size, size)));
    return this;
  }

  /** Bolt circle on a face whose normal is `axis`. */
  boltRing(center: THREE.Vector3, axis: THREE.Vector3, radius: number, count: number, size: number, kind: BoltKind = 'hex', phase = 0): this {
    const n = axis.clone().normalize();
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.z) < 0.9 ? Z : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2;
      const p = center.clone().addScaledVector(u, Math.cos(a) * radius).addScaledVector(v, Math.sin(a) * radius);
      this.bolt(p, n, size, kind);
    }
    return this;
  }

  /** Evenly spaced fasteners from a to b (inclusive) on a surface with `normal`. */
  boltLine(a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3, count: number, size: number, kind: BoltKind = 'hex'): this {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      this.bolt(a.clone().lerp(b, t), normal, size, kind);
    }
    return this;
  }

  object(o: THREE.Object3D): this {
    this.objects.push(o);
    return this;
  }

  anchor(name: string, p: THREE.Vector3): this {
    this.anchors.set(name, p.clone());
    return this;
  }

  isEmpty(): boolean {
    return this.geos.size === 0 && this.objects.length === 0 && this.boltMats.hex.length === 0 && this.boltMats.rivet.length === 0;
  }

  finalize(mats: KitMaterials, state: KitObjState): BuiltFrame {
    const group = new THREE.Group();
    group.name = this.name;
    const meshes: THREE.Mesh[] = [];
    let triangles = 0;
    for (const slot of MAT_SLOTS) {
      const list = this.geos.get(slot);
      if (!list?.length) continue;
      const geo = mergeKit(list);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[slot]);
      mesh.name = `${this.name}:${slot}`;
      mesh.castShadow = slot !== 'glow' && slot !== 'core';
      mesh.receiveShadow = true;
      mesh.userData.kit = state;
      mesh.userData.slot = slot;
      triangles += triangleCount(geo);
      group.add(mesh);
      meshes.push(mesh);
    }
    this.geos.clear();
    const bolts: THREE.InstancedMesh[] = [];
    const shared = sharedBoltGeometries();
    for (const kind of ['hex', 'rivet'] as const) {
      const list = this.boltMats[kind];
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(shared[kind], mats.mech, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.name = `${this.name}:${kind}`;
      inst.castShadow = false;
      inst.receiveShadow = true;
      inst.userData.kit = state;
      inst.userData.slot = 'mech';
      triangles += triangleCount(shared[kind]) * list.length;
      group.add(inst);
      bolts.push(inst);
    }
    for (const o of this.objects) {
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        m.userData.kit ??= state;
        triangles += triangleCount(m.geometry);
      });
      group.add(o);
    }
    return { group, meshes, bolts, triangles };
  }
}
