// Balance: keeps the centre of mass over the support, through real actuators only.
//
//   ankle strategy   the stance servos are posed (IK) with the pelvis displaced against COM
//                    error and velocity, so they push the centre of pressure where it is needed;
//                    a slow integral trims model bias
//   planned motion   the gait's COM plan (pos, vel, acc) feeds forward: the pelvis leads, and
//                    the gravity feed-forward places the centre of pressure at p = c − a/ω₀²
//                    (linear inverted pendulum, c̈ = ω₀²·(c − p))
//   gyro core        when the capture point leaves the support polygon the soles are out of
//                    authority; a COP shift Δ beyond the polygon is worth a torque m·g·(Δ × ẑ)
//                    on the torso, which the gyro supplies until its momentum runs out
//   stepping         the gait takes a capture step when even that is not enough
import type { Vec3 } from '../../core/types';
import { clamp } from './math';
import { GRAVITY, type Sense } from './sense';
import { clampToPolygon, polygonDistance, type P2 } from './support';

export interface BalanceGains {
  ka: number; // pelvis lead per m/s² of planned COM acceleration, s²
  kp: number; // pelvis shift per metre of COM error
  kd: number; // pelvis shift per m/s of COM velocity error, s
  ki: number; // integral trim, 1/s
  gyroCp: number; // gyro COP-equivalent shift per metre of capture point outside the support
  gyroInside: number; // same, for capture-point error while still inside (small: soles cope)
  gyroTilt: number; // torso attitude stiffness, × m·g·h per rad
  gyroRate: number; // torso attitude damping, × m·g·h per rad/s
  gyroRoll: number; // stance-sole roll correction, × m·g·h per rad
}

export const DEFAULT_GAINS: BalanceGains = {
  ka: 0.03, kp: 1, kd: 0.6, ki: 0.5, gyroCp: 1.6, gyroInside: 0, gyroTilt: 0.8, gyroRate: 0.08, gyroRoll: 1.5,
};

const OFFSET_TAU_S = 0.3;
const NO_TORQUE: Vec3 = [0, 0, 0];
const MAX_BIAS_M = 0.08;
const MAX_SHIFT_M = 0.25;
const COP_MARGIN = 0.015; // m kept inside the support polygon for the planned COP
const TILT_DEADBAND_RAD = 0.16; // torso attitude error the servos own; the gyro only fights real tumbles
const RATE_DEADBAND_RAD_S = 0.15; // gait wobble the servos own
const SOLE_ROLL_DEADBAND_RAD = 0.03; // soles sit flat within contact softness

export interface ComPlan {
  pos: P2;
  vel: P2;
  acc: P2;
}

export class Balance {
  private offset: P2 | null = null; // filtered pelvis − COM, horizontal
  private readonly bias: P2 = [0, 0];
  gains: BalanceGains = { ...DEFAULT_GAINS };

  reset(): void {
    this.offset = null;
    this.bias[0] = 0;
    this.bias[1] = 0;
  }

  /**
   * Horizontal pelvis target that drives the COM along the plan. `offsetTau`: how quickly the
   * pelvis-to-COM offset is re-learned (short while the posture itself is changing fast, as when
   * a crouched body unfolds: the COM moves relative to the pelvis and must be chased at once).
   */
  pelvisTarget(s: Sense, plan: ComPlan, dt: number, integrate: boolean, offsetTau = OFFSET_TAU_S): P2 {
    const g = this.gains;
    const off: P2 = [s.pelvisPos[0] - s.com[0], s.pelvisPos[1] - s.com[1]];
    if (!this.offset) this.offset = off;
    const a = Math.min(1, dt / offsetTau);
    this.offset[0] += (off[0] - this.offset[0]) * a;
    this.offset[1] += (off[1] - this.offset[1]) * a;
    const ex = s.com[0] - plan.pos[0], ey = s.com[1] - plan.pos[1];
    if (integrate) {
      this.bias[0] = clamp(this.bias[0] + g.ki * ex * dt, -MAX_BIAS_M, MAX_BIAS_M);
      this.bias[1] = clamp(this.bias[1] + g.ki * ey * dt, -MAX_BIAS_M, MAX_BIAS_M);
    }
    const sx = clamp(g.ka * plan.acc[0] - g.kp * ex - g.kd * (s.comVel[0] - plan.vel[0]) - this.bias[0], -MAX_SHIFT_M, MAX_SHIFT_M);
    const sy = clamp(g.ka * plan.acc[1] - g.kp * ey - g.kd * (s.comVel[1] - plan.vel[1]) - this.bias[1], -MAX_SHIFT_M, MAX_SHIFT_M);
    return [plan.pos[0] + this.offset[0] + sx, plan.pos[1] + this.offset[1] + sy];
  }

  /** Centre of pressure the gravity feed-forward should plan for: under the COM, shifted to
   *  produce the planned acceleration and to carry the gyro core's desaturation torque (a couple
   *  τ is held by the ground only with the COP off the COM by τ/(m·g)), inside the support. */
  plannedCop(s: Sense, plan: ComPlan, support: P2[], gyroTorque: Vec3 = NO_TORQUE): P2 {
    const w2 = s.omega0 * s.omega0;
    const mg = s.mass * GRAVITY;
    const want: P2 = [s.com[0] - plan.acc[0] / w2 + gyroTorque[1] / mg, s.com[1] - plan.acc[1] / w2 - gyroTorque[0] / mg];
    return support.length >= 3 ? clampToPolygon(shrink(support, COP_MARGIN), want) : want;
  }

  /**
   * Gyro torque demand (world). The capture point's excursion beyond the support polygon is
   * the COP shift the soles cannot make; the gyro supplies it as a couple. Inside the support
   * it helps a little (the soles do most of the work) and holds the torso attitude.
   */
  gyroDemand(s: Sense, capRef: P2, support: P2[], torsoTilt: Vec3, soleRoll: P2): Vec3 {
    const g = this.gains;
    const mg = s.mass * GRAVITY;
    const mgh = mg * Math.max(0.5, s.com[2]);
    const cap: P2 = [s.capture[0], s.capture[1]];
    // Momentum is finite: spend it on falls and fast wobbles, never on steady-state errors
    // the servos already hold (a constant demand would only fill the rotor and saturate it).
    let ex = 0, ey = 0;
    if (support.length >= 3) {
      const { d, closest } = polygonDistance(support, cap);
      if (d > 0) {
        ex = g.gyroCp * (cap[0] - closest[0]);
        ey = g.gyroCp * (cap[1] - closest[1]);
      }
    }
    void capRef;
    const tx = deadband(torsoTilt[0], TILT_DEADBAND_RAD), ty = deadband(torsoTilt[1], TILT_DEADBAND_RAD);
    const wx = deadband(s.torsoOmega[0], RATE_DEADBAND_RAD_S), wy = deadband(s.torsoOmega[1], RATE_DEADBAND_RAD_S);
    // A planted sole rolling onto its edge means the whole robot is pivoting about that edge:
    // push the body back so the sole lands flat again.
    const rx = deadband(soleRoll[0], SOLE_ROLL_DEADBAND_RAD), ry = deadband(soleRoll[1], SOLE_ROLL_DEADBAND_RAD);
    // COP shift Δ ⇒ torque m·g·(Δy, −Δx, 0)
    return [
      mg * ey + mgh * (g.gyroTilt * tx - g.gyroRate * wx + g.gyroRoll * rx),
      -mg * ex + mgh * (g.gyroTilt * ty - g.gyroRate * wy + g.gyroRoll * ry),
      0,
    ];
  }
}

function deadband(x: number, band: number): number {
  return x > band ? x - band : x < -band ? x + band : 0;
}

/** Shrink a convex polygon toward its centroid by about `margin` metres. */
function shrink(poly: P2[], margin: number): P2[] {
  let cx = 0, cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, d - margin) / d;
    return [cx + dx * k, cy + dy * k] as P2;
  });
}
