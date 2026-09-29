// Placeholder robot view: one Group per physics body, meshes from the collision geoms.
// The robot-kit module swaps these for detailed hard-surface parts and skins, keeping
// the same contract: `groups[body]` follows the body pose every frame.
import * as THREE from 'three/webgpu';
import type { WorldMeta } from '../core/protocol';
import type { GeomDef, Quat, Vec3 } from '../core/types';
import { design } from '../robots/designs';

export interface RobotView {
  corner: 0 | 1;
  parts: Map<string, { attached: THREE.Group; debris: THREE.Group | null }>;
}

const up = new THREE.Vector3(0, 1, 0);

export function geomMesh(g: GeomDef, material: THREE.Material): THREE.Mesh {
  const s = g.shape;
  let mesh: THREE.Mesh;
  switch (s.type) {
    case 'box':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s.halfSize[0] * 2, s.halfSize[1] * 2, s.halfSize[2] * 2), material);
      mesh.position.set(...(g.pos ?? [0, 0, 0]));
      if (g.quat) mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
      break;
    case 'sphere':
      mesh = new THREE.Mesh(new THREE.SphereGeometry(s.radius, 24, 16), material);
      mesh.position.set(...(g.pos ?? [0, 0, 0]));
      break;
    case 'capsule':
    case 'cylinder': {
      const a = new THREE.Vector3(...s.from);
      const b = new THREE.Vector3(...s.to);
      const length = a.distanceTo(b);
      const geo = s.type === 'capsule'
        ? new THREE.CapsuleGeometry(s.radius, length, 8, 20)
        : new THREE.CylinderGeometry(s.radius, s.radius, length, 24);
      mesh = new THREE.Mesh(geo, material);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
      break;
    }
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const CORNER_COLORS = [0xb0341f, 0x1f4fb0];

export function buildRobotViews(meta: WorldMeta, physicsRoot: THREE.Group): { views: RobotView[]; bodyGroups: Map<number, THREE.Group> } {
  const bodyGroups = new Map<number, THREE.Group>();
  const views: RobotView[] = [];
  for (const r of meta.robots) {
    const d = design(r.design);
    const armor = new THREE.MeshStandardMaterial({ color: CORNER_COLORS[r.corner], metalness: 0.7, roughness: 0.38 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.85, roughness: 0.45 });
    const view: RobotView = { corner: r.corner, parts: new Map() };
    for (const pm of r.parts) {
      const part = d.parts.find((p) => p.id === pm.id)!;
      const make = () => {
        const group = new THREE.Group();
        for (const g of part.geoms) group.add(geomMesh(g, g.role === 'armor' || g.role === 'sensor' ? armor : frame));
        return group;
      };
      const attached = make();
      physicsRoot.add(attached);
      bodyGroups.set(pm.body, attached);
      let debris: THREE.Group | null = null;
      if (pm.debrisBody !== null) {
        debris = make();
        // Debris copies also carry the rigid descendants (e.g. a fist on a forearm); the
        // robot kit handles that. The placeholder shows the part itself.
        debris.visible = false;
        physicsRoot.add(debris);
        bodyGroups.set(pm.debrisBody, debris);
      }
      view.parts.set(pm.id, { attached, debris });
    }
    views.push(view);
  }
  return { views, bodyGroups };
}

export function applyPoses(poses: Float32Array, bodyGroups: Map<number, THREE.Group>): void {
  for (const [body, group] of bodyGroups) {
    const o = body * 7;
    group.position.set(poses[o], poses[o + 1], poses[o + 2]);
    group.quaternion.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]);
  }
}

export type { Quat, Vec3 };
