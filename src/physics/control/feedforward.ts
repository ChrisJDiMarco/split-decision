// Feed-forward gravity compensation, delivered the only honest way a position servo allows:
// by shifting its target by τ/kp. For a static pose the joint torque that holds the robot is
//   τ = qfrc_bias − Jᵀ·F_ground
// where qfrc_bias is MuJoCo's gravity (+ Coriolis) load on that joint and F_ground is the
// planned ground reaction under each stance foot, acting at that foot's centre of pressure.
// For a hinge whose subtree holds the contact point p: (Jᵀ·F)_j = axis_j · ((p − anchor_j) × F).
import type { Vec3 } from '../../core/types';
import type { RobotRuntime } from '../sim-context';
import type { Side } from './geometry';
import { GRAVITY, type Views } from './sense';

export interface JointInfo {
  index: number; // into r.joints / r.targets
  name: string;
  dof: number;
  jnt: number; // joint id (xanchor / xaxis rows)
  leg: Side | null; // stance-leg joints carry ground reaction
}

export interface FootLoad {
  share: number; // fraction of body weight on this foot, 0..1
  cop: Vec3; // centre of pressure, world
}

export function jointInfo(r: RobotRuntime, dofJnt: ArrayLike<number>): JointInfo[] {
  return r.joints.map((j, index) => {
    const legSide = /^(thigh|shin|foot)_([lr])$/.exec(j.part);
    return { index, name: j.name, dof: j.dadr, jnt: dofJnt[j.dadr], leg: legSide ? (legSide[2] as Side) : null };
  });
}

/** Servo gain actually in force (the motor system scales kp for limp and seized joints). */
export function effectiveKp(r: RobotRuntime, index: number): number {
  const j = r.joints[index];
  if (j.state === 'limp') return 0;
  return j.state === 'seized' ? j.kp * 3 : j.kp;
}

/**
 * Adds the gravity / ground-reaction feed-forward to `targets` (radians) in place.
 * `gain` scales the whole term (1 = full compensation).
 */
export function applyGravityFeedforward(
  v: Views, r: RobotRuntime, joints: readonly JointInfo[], loads: Record<Side, FootLoad>,
  mass: number, targets: Float64Array, gain = 1,
): void {
  const fzL = loads.l.share * mass * GRAVITY;
  const fzR = loads.r.share * mass * GRAVITY;
  for (const ji of joints) {
    const kp = effectiveKp(r, ji.index);
    if (kp <= 0) continue;
    let tau = v.qfrcBias[ji.dof];
    if (ji.leg) {
      const load = ji.leg === 'l' ? loads.l : loads.r;
      const fz = ji.leg === 'l' ? fzL : fzR;
      if (fz > 0) {
        const a = ji.jnt * 3;
        const dx = load.cop[0] - v.xanchor[a];
        const dy = load.cop[1] - v.xanchor[a + 1];
        // axis · ((p − anchor) × (0, 0, fz)) = fz · (axis_x·dy − axis_y·dx)
        tau -= fz * (v.xaxis[a] * dy - v.xaxis[a + 1] * dx);
      }
    }
    const avail = r.joints[ji.index].availableTorque;
    const t = Math.max(-avail, Math.min(avail, tau * gain));
    targets[ji.index] += t / kp;
  }
}

const VEL_FILTER_S = 0.012;
const MAX_VEL_SHIFT_RAD = 0.35;

/**
 * Velocity feed-forward from a known target velocity (a mocap clip's exact q̇): the target is
 * shifted by (kd/kp)·q̇_des so the servo's damping acts on the tracking error, not on the motion.
 * `qd` is in r.joints order, rad/s.
 */
export function addVelocityFeedforward(r: RobotRuntime, targets: Float64Array, qd: ArrayLike<number>): void {
  for (let i = 0; i < targets.length; i++) {
    const kp = effectiveKp(r, i);
    if (kp <= 0) continue;
    const j = r.joints[i];
    const v = Math.max(-j.motor.noLoadSpeedRadS, Math.min(j.motor.noLoadSpeedRadS, qd[i]));
    targets[i] += Math.max(-MAX_VEL_SHIFT_RAD, Math.min(MAX_VEL_SHIFT_RAD, (j.kd * v) / kp));
  }
}

/**
 * Velocity feed-forward. A position servo's damping acts on absolute joint speed, so it drags
 * against every commanded motion (kd·q̇ is ~270 N·m on a knee at 4 rad/s). Shifting the target
 * by (kd/kp)·q̇_des turns kv into damping on the tracking error instead. q̇_des is the filtered
 * rate of change of the posture targets, capped at the motor's no-load speed.
 *
 * Joints flagged in `hold` get no shift: their targets merely follow the measured body (a stance
 * hip yaw tracking a pelvis that is being spun), and adding the body's own motion to the target
 * would push the body further the same way.
 */
export class VelocityFeedforward {
  private prev: Float64Array | null = null;
  private readonly rate: Float64Array;
  readonly hold: Uint8Array;

  constructor(n: number) {
    this.rate = new Float64Array(n);
    this.hold = new Uint8Array(n);
  }

  reset(): void {
    this.prev = null;
    this.rate.fill(0);
  }

  apply(r: RobotRuntime, targets: Float64Array, dt: number): void {
    if (!this.prev) {
      this.prev = Float64Array.from(targets);
      return;
    }
    const a = dt / (VEL_FILTER_S + dt);
    for (let i = 0; i < targets.length; i++) {
      const j = r.joints[i];
      const vmax = j.motor.noLoadSpeedRadS;
      const raw = Math.max(-vmax, Math.min(vmax, (targets[i] - this.prev[i]) / dt));
      this.rate[i] += (raw - this.rate[i]) * a;
      this.prev[i] = targets[i];
      const kp = effectiveKp(r, i);
      if (kp <= 0 || this.hold[i]) continue;
      const shift = (j.kd * this.rate[i]) / kp;
      targets[i] += Math.max(-MAX_VEL_SHIFT_RAD, Math.min(MAX_VEL_SHIFT_RAD, shift));
    }
  }
}
