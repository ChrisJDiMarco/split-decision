// Headless helpers: build a kit view in Node with fake body ids and pose it by FK.
import * as THREE from 'three/webgpu';
import type { RobotDesign, SkinId } from '../../src/core/types';
import { design } from '../../src/robots/designs';
import { buildRobotKitView, forwardKinematics, type PartMeta } from '../../src/render/robot-kit';
import type { RobotKitView } from '../../src/render/robot-kit/types';

export interface TestRobot {
  view: RobotKitView;
  root: THREE.Group;
  byPart: Map<string, THREE.Group>;
  debrisGroups: Map<string, THREE.Group>;
  design: RobotDesign;
}

export function buildTestRobot(designId: string, skin: SkinId = 'factory', corner: 0 | 1 = 0): TestRobot {
  const d = design(designId);
  const root = new THREE.Group();
  const bodyGroups = new Map<number, THREE.Group>();
  let next = 1;
  const parts: PartMeta[] = d.parts.map((p) => ({ id: p.id, body: next++, debrisBody: null }));
  for (const pm of parts) if (d.parts.find((p) => p.id === pm.id)?.detachable) pm.debrisBody = next++;
  const view = buildRobotKitView(d, skin, corner, parts, root, bodyGroups);
  const byPart = new Map<string, THREE.Group>();
  const debrisGroups = new Map<string, THREE.Group>();
  for (const pm of parts) {
    byPart.set(pm.id, bodyGroups.get(pm.body)!);
    if (pm.debrisBody !== null) debrisGroups.set(pm.id, bodyGroups.get(pm.debrisBody)!);
  }
  return { view, root, byPart, debrisGroups, design: d };
}

/** Pose the robot's body groups with FK at the given joint angles (defaults to the stance). */
export function poseRobot(r: TestRobot, q: Record<string, number> = r.design.stance): void {
  const poses = forwardKinematics(r.design, q, new THREE.Vector3(0, 0, r.design.rootHeight), new THREE.Quaternion());
  for (const [id, pose] of poses) {
    const g = r.byPart.get(id);
    if (!g) continue;
    g.position.copy(pose.pos);
    g.quaternion.copy(pose.quat);
  }
  r.root.updateMatrixWorld(true);
}

/** Box of the meshes under `root` in root's parent frame, skipping named slots. */
export function meshBox(root: THREE.Object3D, skipSlots: string[] = []): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || skipSlots.includes(m.userData.slot)) return;
    box.union(new THREE.Box3().setFromObject(m));
  });
  return box;
}
