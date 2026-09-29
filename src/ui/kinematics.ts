// Forward kinematics over a RobotDesign's part tree, without MuJoCo. Used for the HUD
// silhouette, the tale-of-the-tape height and the harness's fake fighters.
// Frames follow MuJoCo: body = parent ∘ T(pos) ∘ R(quat) ∘ R(joint 1) ∘ R(joint 2)...
import type { GeomDef, Quat, RobotDesign, Vec3 } from '../core/types';
import { addV, mulQ, rotate } from '../robots/compile-mjcf';

export interface PartPose {
  pos: Vec3;
  quat: Quat;
}

export const IDENTITY_QUAT: Quat = [1, 0, 0, 0];

export function axisAngle(axis: Vec3, angle: number): Quat {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / len;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/**
 * World pose of every part. `angles` holds joint positions by design-level joint name
 * (missing = 0). Hinge joints rotate; slide joints translate along their axis.
 */
export function partPoses(
  design: RobotDesign,
  angles: Record<string, number> = {},
  root: PartPose = { pos: [0, 0, design.rootHeight], quat: IDENTITY_QUAT },
): Map<string, PartPose> {
  const out = new Map<string, PartPose>();
  for (const p of design.parts) {
    const parent = p.parent ? out.get(p.parent) : undefined;
    let pos: Vec3;
    let quat: Quat;
    if (!parent) {
      pos = root.pos;
      quat = root.quat;
    } else {
      pos = addV(parent.pos, rotate(parent.quat, p.pos));
      quat = p.quat ? mulQ(parent.quat, p.quat) : parent.quat;
    }
    for (const j of p.joints ?? []) {
      const q = angles[j.name] ?? 0;
      if (j.type === 'hinge') quat = mulQ(quat, axisAngle(j.axis, q));
      else pos = addV(pos, rotate(quat, [j.axis[0] * q, j.axis[1] * q, j.axis[2] * q]));
    }
    out.set(p.id, { pos, quat });
  }
  return out;
}

/** Key points of a geom in its part frame (box corners, capsule ends...) plus a padding radius. */
export function geomPoints(g: GeomDef): { points: Vec3[]; radius: number } {
  const s = g.shape;
  switch (s.type) {
    case 'box': {
      const [x, y, z] = s.halfSize;
      const c = g.pos ?? [0, 0, 0];
      const q = g.quat ?? IDENTITY_QUAT;
      const points: Vec3[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        points.push(addV(c, rotate(q, [sx * x, sy * y, sz * z])));
      }
      return { points, radius: 0 };
    }
    case 'sphere':
      return { points: [g.pos ?? [0, 0, 0]], radius: s.radius };
    case 'capsule':
    case 'cylinder':
      return { points: [s.from, s.to], radius: s.radius };
  }
}

/** Vertical extent of the design in its zero pose: [lowest z, highest z] in world. */
export function verticalExtent(design: RobotDesign): [number, number] {
  const poses = partPoses(design);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of design.parts) {
    const pose = poses.get(p.id)!;
    for (const g of p.geoms) {
      const { points, radius } = geomPoints(g);
      for (const pt of points) {
        const w = addV(pose.pos, rotate(pose.quat, pt));
        lo = Math.min(lo, w[2] - radius);
        hi = Math.max(hi, w[2] + radius);
      }
    }
  }
  return [lo, hi];
}
