// Harness-only robot meshes: one group per body from the design's collision geoms, tinted
// by the chosen skin swatch. The real robot kit replaces this in the app.
import * as THREE from 'three/webgpu';
import type { WorldMeta } from '../../core/protocol';
import type { GeomDef, MatchSetup } from '../../core/types';
import { design as getDesign } from '../../robots/designs';
import { SKIN_SWATCHES } from '../skins';

const PARKED_BEYOND_M = 25; // bodies further out than this are parked debris: hide them
const UP = new THREE.Vector3(0, 1, 0);

function geomMesh(g: GeomDef, material: THREE.Material): THREE.Mesh {
  const s = g.shape;
  let mesh: THREE.Mesh;
  if (s.type === 'box') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(s.halfSize[0] * 2, s.halfSize[1] * 2, s.halfSize[2] * 2), material);
    mesh.position.set(...(g.pos ?? [0, 0, 0]));
    if (g.quat) mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
  } else if (s.type === 'sphere') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(s.radius, 20, 14), material);
    mesh.position.set(...(g.pos ?? [0, 0, 0]));
  } else {
    const a = new THREE.Vector3(...s.from);
    const b = new THREE.Vector3(...s.to);
    const len = a.distanceTo(b);
    const geo = s.type === 'capsule' ? new THREE.CapsuleGeometry(s.radius, len, 6, 16) : new THREE.CylinderGeometry(s.radius, s.radius, len, 20);
    mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class FakeRobotView {
  private groups = new Map<number, THREE.Group>();

  constructor(root: THREE.Group, meta: WorldMeta, setup: MatchSetup) {
    for (const r of meta.robots) {
      const d = getDesign(r.design);
      const sw = SKIN_SWATCHES[setup.fighters[r.corner].skin];
      const armor = new THREE.MeshStandardMaterial({ color: sw.base, metalness: 0.75, roughness: 0.35 });
      const trim = new THREE.MeshStandardMaterial({ color: sw.accent, metalness: 0.5, roughness: 0.45 });
      const frame = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.85, roughness: 0.45 });
      for (const pm of r.parts) {
        const part = d.parts.find((p) => p.id === pm.id)!;
        const make = () => {
          const g = new THREE.Group();
          for (const geom of part.geoms) g.add(geomMesh(geom, geom.role === 'armor' ? armor : geom.role === 'sensor' || geom.role === 'striker' ? trim : frame));
          root.add(g);
          return g;
        };
        this.groups.set(pm.body, make());
        if (pm.debrisBody !== null) this.groups.set(pm.debrisBody, make());
      }
    }
  }

  apply(poses: Float32Array): void {
    for (const [body, g] of this.groups) {
      const o = body * 7;
      g.position.set(poses[o], poses[o + 1], poses[o + 2]);
      g.quaternion.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]);
      g.visible = Math.hypot(poses[o], poses[o + 1]) < PARKED_BEYOND_M;
    }
  }

  /** Detach and free the GPU resources (every REMATCH builds a fresh view). */
  dispose(): void {
    const materials = new Set<THREE.Material>();
    for (const g of this.groups.values()) {
      g.removeFromParent();
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        materials.add(o.material as THREE.Material);
      });
    }
    for (const m of materials) m.dispose();
    this.groups.clear();
  }
}
