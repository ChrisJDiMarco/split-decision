// Joint frames. MuJoCo applies a body's hinges in order about axes in the rotating frame:
//   q_child = q_parent · q_body · R(a0, θ0) · R(a1, θ1) · …
// A part with n joints gets frames F0..F(n-1) under its parent: F0 sits at the body offset,
// Fk turns by θ(k-1). The stator of joint k lives in Fk, so every housing stays on its own axis
// while the others move. Angles are recovered from the two body poses each render frame.
import * as THREE from 'three/webgpu';
import type { PartDef } from '../../../core/types';

type Letter = 'x' | 'y' | 'z';

export interface JointChain {
  letters: Letter[]; // principal axis of each joint
  signs: number[]; // +1 / -1 if the axis points along -letter
  order: string | null; // Euler order that decomposes the chain, null if not principal
  axes: THREE.Vector3[];
  bodyQuatInv: THREE.Quaternion;
}

function principal(axis: [number, number, number]): { letter: Letter; sign: number } | null {
  const [x, y, z] = axis;
  const l = Math.hypot(x, y, z) || 1;
  const dims: Array<[Letter, number]> = [['x', x / l], ['y', y / l], ['z', z / l]];
  for (const [letter, c] of dims) if (Math.abs(Math.abs(c) - 1) < 1e-4) return { letter, sign: Math.sign(c) };
  return null;
}

export function jointChain(part: PartDef): JointChain {
  const joints = part.joints ?? [];
  const letters: Letter[] = [];
  const signs: number[] = [];
  let ok = joints.every((j) => j.type === 'hinge');
  for (const j of joints) {
    const p = principal(j.axis);
    if (!p) {
      ok = false;
      break;
    }
    letters.push(p.letter);
    signs.push(p.sign);
  }
  if (new Set(letters).size !== letters.length) ok = false;
  let order: string | null = null;
  if (ok && joints.length >= 2) {
    const rest = (['x', 'y', 'z'] as Letter[]).filter((l) => !letters.includes(l));
    order = [...letters, ...rest].join('').toUpperCase();
  }
  const q = part.quat ?? [1, 0, 0, 0];
  return {
    letters: ok ? letters : [],
    signs: ok ? signs : [],
    order,
    axes: joints.map((j) => new THREE.Vector3(...j.axis).normalize()),
    bodyQuatInv: new THREE.Quaternion(q[1], q[2], q[3], q[0]).invert(),
  };
}

const qRel = new THREE.Quaternion();
const euler = new THREE.Euler();

/** Joint angles (radians) from parent and child orientations in a shared space. */
export function jointAngles(chain: JointChain, qParent: THREE.Quaternion, qChild: THREE.Quaternion, out: number[]): number[] {
  const n = chain.letters.length;
  out.length = n;
  if (n === 0) return out;
  qRel.copy(qParent).invert().multiply(qChild).premultiply(chain.bodyQuatInv);
  if (n === 1) {
    const c = chain.letters[0] === 'x' ? qRel.x : chain.letters[0] === 'y' ? qRel.y : qRel.z;
    let a = 2 * Math.atan2(c, qRel.w);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a < -Math.PI) a += 2 * Math.PI;
    out[0] = a * chain.signs[0];
    return out;
  }
  euler.setFromQuaternion(qRel, chain.order as THREE.EulerOrder);
  for (let k = 0; k < n; k++) out[k] = euler[chain.letters[k]] * chain.signs[k];
  return out;
}

/** Apply angles to frames F1..F(n-1) (F0 is static; the last joint turns the body itself). */
export function poseFrames(frames: ReadonlyArray<{ group: THREE.Object3D }>, chain: JointChain, angles: number[]): void {
  for (let k = 1; k < frames.length; k++) {
    frames[k].group.quaternion.setFromAxisAngle(chain.axes[k - 1], angles[k - 1] ?? 0);
  }
}

/** Relative pose of `child` in `parent`'s frame (both expressed in the same space). */
export function relativePose(parent: THREE.Object3D, child: THREE.Object3D, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  outQuat.copy(parent.quaternion).invert();
  outPos.copy(child.position).sub(parent.position).applyQuaternion(outQuat);
  outQuat.multiply(child.quaternion);
}
