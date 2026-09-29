// The gyro core: a dual-gimbal control moment gyroscope in the torso. It is a physical part,
// not a hand of god:
//   · its torque on the torso is capped at GyroSpec.maxTorqueNm × health (pitch and roll only),
//   · every N·m·s it hands the body comes out of its rotor: stored momentum h changes by −τ·dt,
//     and once |h| reaches momentumNms it cannot push any further that way (saturation),
//   · it desaturates by bleeding h back into the body as a small real torque the feet must absorb,
//     so it cannot hold a sustained lean forever,
//   · it draws electrical power from the battery.
// The torque goes into data.xfrc_applied on the torso body as a pure couple (world frame).
import type { GyroSpec, Vec3 } from '../../core/types';
import type { RobotRuntime } from '../sim-context';
import { clamp, type Mat3 } from './math';

const BLEED_TIME_S = 1.2; // desaturation time constant (the ankles absorb the unloading torque)
const IDLE_POWER_FRAC = 0.15; // spin-up losses at zero output
const BATTERY_J = 1.2 * 3.6e6; // same 1.2 kWh pack the motor model drains

export class GyroCore {
  /** Stored angular momentum about the torso roll (x) and pitch (y) axes, N·m·s. */
  readonly h: [number, number] = [0, 0];
  /** Torque currently applied to the torso, world frame. */
  readonly applied: Vec3 = [0, 0, 0];
  /** The desaturation share of it, world frame: stored momentum handed back to a body that is not
   *  falling, which the soles must carry (the corrective share is meant to turn the body). */
  readonly bleeding: Vec3 = [0, 0, 0];
  saturation = 0;
  powerW = 0;
  impulseDelivered = 0; // |∫τ dt| handed to the body, N·m·s (telemetry / tests)

  constructor(readonly spec: GyroSpec) {}

  /**
   * Turns a world-frame torque demand into what the gyro can actually deliver this tick and
   * writes it into xfrc_applied (replacing last tick's contribution only). `bleedS`: how fast
   * stored momentum is dumped back into the body (a body lying on the canvas can take it fast).
   */
  update(r: RobotRuntime, torsoRot: Mat3, demand: Vec3, dt: number, xfrc: Float64Array, torsoBody: number, enabled: boolean, bleedS = BLEED_TIME_S, bleedMaxNm = Infinity): void {
    const health = enabled ? clamp(r.gyro?.health ?? 0, 0, 1) : 0;
    const tMax = this.spec.maxTorqueNm * health;
    const H = this.spec.momentumNms;
    const local: [number, number] = [0, 0];
    const bleed: [number, number] = [0, 0];
    // Desaturation: the stored momentum goes back into the body at no more than the feet can take.
    const bleedMag = Math.hypot(this.h[0], this.h[1]) / bleedS;
    const bleedK = bleedMag > bleedMaxNm ? bleedMaxNm / bleedMag : 1;
    for (let i = 0; i < 2; i++) {
      // Demand along the torso's roll (x) / pitch (y) axis: columns 0 and 1 of the rotation.
      const want = demand[0] * torsoRot[i] + demand[1] * torsoRot[3 + i] + demand[2] * torsoRot[6 + i];
      bleed[i] = (this.h[i] / bleedS) * bleedK;
      local[i] = want + bleed[i];
    }
    // One gimbal pair, one torque budget: clamp the vector, not each axis.
    const mag = Math.hypot(local[0], local[1]);
    const capK = mag > tMax ? tMax / mag : 1;
    local[0] *= capK;
    local[1] *= capK;
    for (let i = 0; i < 2; i++) {
      // h' = h − τ·dt must stay inside ±H.
      local[i] = health > 0 ? clamp(local[i], (this.h[i] - H) / dt, (this.h[i] + H) / dt) : 0;
      this.h[i] -= local[i] * dt;
      bleed[i] = health > 0 ? bleed[i] * capK : 0;
    }
    this.bleeding[0] = torsoRot[0] * bleed[0] + torsoRot[1] * bleed[1];
    this.bleeding[1] = torsoRot[3] * bleed[0] + torsoRot[4] * bleed[1];
    this.bleeding[2] = torsoRot[6] * bleed[0] + torsoRot[7] * bleed[1];
    const out = Math.hypot(local[0], local[1]);
    const world: Vec3 = [
      torsoRot[0] * local[0] + torsoRot[1] * local[1],
      torsoRot[3] * local[0] + torsoRot[4] * local[1],
      torsoRot[6] * local[0] + torsoRot[7] * local[1],
    ];
    const o = torsoBody * 6 + 3;
    xfrc[o] += world[0] - this.applied[0];
    xfrc[o + 1] += world[1] - this.applied[1];
    xfrc[o + 2] += world[2] - this.applied[2];
    this.applied[0] = world[0];
    this.applied[1] = world[1];
    this.applied[2] = world[2];
    this.impulseDelivered += Math.hypot(local[0], local[1]) * dt;
    this.saturation = Math.max(Math.abs(this.h[0]), Math.abs(this.h[1])) / H;
    this.powerW = health > 0 ? this.spec.powerW * (IDLE_POWER_FRAC + (1 - IDLE_POWER_FRAC) * (out / Math.max(1e-6, this.spec.maxTorqueNm))) : 0;
    r.battery = Math.max(0, r.battery - (this.powerW * dt) / BATTERY_J);
    if (r.gyro) r.gyro.saturation = this.saturation;
  }

  /** Remove this gyro's contribution from xfrc_applied (robot down, gyro off). */
  release(xfrc: Float64Array, torsoBody: number): void {
    const o = torsoBody * 6 + 3;
    for (let i = 0; i < 3; i++) {
      xfrc[o + i] -= this.applied[i];
      this.applied[i] = 0;
      this.bleeding[i] = 0;
    }
  }
}
