// Target poses for the Phase 0 tests, in the pelvis frame (x forward, y left, z up), LEFT leg.
// A pose is a thigh direction d and the direction the shin folds when the knee bends, f; the knee
// axis is k = d × f (the knee hinge is +y in the thigh frame and folds the shin along k × d).
// Following docs/research/10-engineai-fighters.md §5.
import { DEG, cross, mul, ry, rz, unit, type M3, type V3 } from './math3';

export interface KickPose { id: string; label: string; d: V3; k: V3; knee: number; note: string }

const pose = (id: string, label: string, d: V3, f: V3, knee: number, note: string): KickPose => {
  const du = unit(d);
  return { id, label, d: du, k: unit(cross(du, unit(f))), knee, note };
};

const c30 = Math.cos(30 * DEG), s30 = Math.sin(30 * DEG), c45 = Math.SQRT1_2;

export const KICKS: readonly KickPose[] = [
  pose('front', 'front kick', [1, 0, 0], [0, 0, -1], 0, 'thigh level forward, leg straight'),
  // Side kicks lead with the heel: toes down, so the knee folds UP (a fold down is a turned-out
  // "frog" lift with the toes up, which a yaw-first hip reaches with yaw 90° + flexion; not a side kick).
  pose('side', 'side kick', [0, 1, 0], [0, 0, 1], 0, 'thigh level out to the side, heel leading (knee axis front-back, folds up), leg straight'),
  pose('high_side', 'high side kick', [0, c30, s30], [0, -s30, c30], 0, 'thigh 30° above level out to the side, heel leading'),
  pose('roundhouse', 'roundhouse turnover', [c45, c45, 0], [-c45, c45, 0], 90 * DEG, 'thigh 45° out-forward and level, shin folded level (knee 90°, axis vertical)'),
];

/** Elevated side / front / roundhouse directions for the reachable-height sweep. */
export function elevated(id: 'front' | 'side' | 'roundhouse', elevDeg: number): KickPose {
  const e = elevDeg * DEG, c = Math.cos(e), s = Math.sin(e);
  if (id === 'front') return pose('front', 'front', [c, 0, s], [s, 0, -c], 0, '');
  if (id === 'side') return pose('side', 'side', [0, c, s], [0, -s, c], 0, '');
  // roundhouse: thigh 45° out-forward, raised; shin folded level-ish, perpendicular in the horizontal sense
  const d: V3 = [c45 * c, c45 * c, s];
  const f = unit(cross([0, 0, 1], d)); // horizontal, ⊥ d, toward the back-left
  return pose('roundhouse', 'roundhouse', d, f, 90 * DEG, '');
}

/**
 * Crouched pivot over a planted LEFT foot: the pelvis turns ψ about the vertical relative to the foot
 * (external direction: the left toes turn out relative to the pelvis), thigh flexed θ in the foot's
 * own sagittal plane, knee 2θ, ankle −θ so the foot stays flat and the pelvis level.
 */
export function pivotTarget(psiDeg: number, flexDeg: number): M3 {
  return mul(rz(psiDeg * DEG), ry(-flexDeg * DEG));
}
