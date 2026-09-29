// Forward kinematics from a design and joint angles, mirroring MuJoCo's body chain:
//   x_child = x_parent · T(pos) · R(quat) · Π R(axis_k, q_k)
// Used by the showroom (no physics) and by tests to check the rig.
import * as THREE from 'three/webgpu';
import type { RobotDesign } from '../../core/types';

export interface BodyPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export function forwardKinematics(design: RobotDesign, q: Record<string, number>, rootPos: THREE.Vector3, rootQuat: THREE.Quaternion): Map<string, BodyPose> {
  const out = new Map<string, BodyPose>();
  const axisQ = new THREE.Quaternion();
  for (const part of design.parts) {
    let pos: THREE.Vector3;
    let quat: THREE.Quaternion;
    if (!part.parent) {
      pos = rootPos.clone();
      quat = rootQuat.clone();
    } else {
      const parent = out.get(part.parent);
      if (!parent) throw new Error(`fk: parent '${part.parent}' of '${part.id}' not posed yet`);
      pos = new THREE.Vector3(...part.pos).applyQuaternion(parent.quat).add(parent.pos);
      quat = parent.quat.clone();
      if (part.quat) quat.multiply(new THREE.Quaternion(part.quat[1], part.quat[2], part.quat[3], part.quat[0]));
      for (const j of part.joints ?? []) {
        if (j.type !== 'hinge') continue;
        axisQ.setFromAxisAngle(new THREE.Vector3(...j.axis).normalize(), q[j.name] ?? 0);
        quat.multiply(axisQ);
      }
    }
    out.set(part.id, { pos, quat });
  }
  return out;
}

/** Write FK poses into body groups (the same thing applyPoses does from the physics buffer). */
export function applyBodyPoses(poses: Map<string, BodyPose>, groups: Map<string, THREE.Object3D>): void {
  for (const [id, pose] of poses) {
    const g = groups.get(id);
    if (!g) continue;
    g.position.copy(pose.pos);
    g.quaternion.copy(pose.quat);
  }
}
