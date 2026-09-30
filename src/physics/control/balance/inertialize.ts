// Inertialized target switches (docs/design/balance-engine.md, "Motion matching, the physics
// way"). When the servo targets switch source (clip to clip, clip to procedural, strike to guard,
// a cancelled windup, get-up to stance) the new targets are not jumped to: the old pose's offset
// from them decays as a critically damped spring,
//   x(t) = (x₀ + (v₀ + ω·x₀)·t)·e^{−ωt}
// gone in ~0.15 s at ω = 30 s⁻¹. A target step drives a position servo straight to stall torque,
// so this is a balance fix as much as a looks fix. Switches are marked by the controller; on the
// arms and waist (the joints skills own) any single-tick jump no motor could follow (> 2.5 × its
// no-load speed) is treated as one too. The legs are the balance engine's, continuous by
// construction, and switch only when marked (a kick taking or handing back its leg): their IK
// targets can legitimately move fast near a straight knee. Smooth motion, however fast, passes
// through untouched: punches keep every rad/s.
import { clamp } from '../math';

/** Tunable (tools sweep it; the worker never changes it). */
export const INERTIA = {
  omega: 30, // 1/s: offset mostly gone after ~0.15 s
  jumpSpeeds: 2.5, // a one-tick target change beyond this × no-load speed × dt is a switch
  minJumpRad: 0.1,
  maxOffsetRad: 1.2, // larger offsets are clipped (a get-up's crouch to the stance)
  holdoffS: 0.05, // a joint just switched is not re-detected for this long
};

export class Inertializer {
  private readonly x: Float64Array; // offset added to the new source
  private readonly v: Float64Array; // its rate
  private readonly prevRaw: Float64Array;
  private readonly prevOut: Float64Array;
  private readonly outVel: Float64Array;
  private readonly pending: Uint8Array;
  private readonly skip: Uint8Array;
  private readonly auto: Uint8Array;
  private readonly since: Float64Array;
  private primed = false;
  enabled = true;
  /** Switches seen (telemetry for the drills). */
  switches = 0;

  /**
   * `noLoad`: each joint's motor no-load speed (rad/s). `skip`: joints left alone (the neck, which
   * gaze owns). `auto`: joints whose unmarked jumps count as switches (arms, waist).
   */
  constructor(n: number, private readonly noLoad: ArrayLike<number>, skip: readonly number[] = [], auto: readonly number[] = []) {
    this.x = new Float64Array(n);
    this.v = new Float64Array(n);
    this.prevRaw = new Float64Array(n);
    this.prevOut = new Float64Array(n);
    this.outVel = new Float64Array(n);
    this.pending = new Uint8Array(n);
    this.skip = new Uint8Array(n);
    this.auto = new Uint8Array(n);
    this.since = new Float64Array(n).fill(Infinity);
    for (const i of skip) this.skip[i] = 1;
    for (const i of auto) this.auto[i] = 1;
  }

  /** The target source of these joints (all by default) switches this tick. */
  mark(joints?: readonly number[]): void {
    if (!joints) this.pending.fill(1);
    else for (const i of joints) this.pending[i] = 1;
  }

  /** Forget everything (the next targets are taken as they come). */
  reset(): void {
    this.primed = false;
    this.x.fill(0);
    this.v.fill(0);
    this.pending.fill(0);
  }

  /** Rewrites `q` (targets, in place) through the decaying offsets. */
  apply(q: Float64Array, dt: number): void {
    const n = q.length;
    if (!this.primed || !this.enabled) {
      for (let i = 0; i < n; i++) {
        this.prevRaw[i] = q[i];
        this.prevOut[i] = q[i];
        this.outVel[i] = 0;
        this.x[i] = this.v[i] = 0;
      }
      this.pending.fill(0);
      this.primed = this.enabled;
      return;
    }
    const w = INERTIA.omega;
    const decay = Math.exp(-w * dt);
    for (let i = 0; i < n; i++) {
      const raw = q[i];
      if (this.skip[i]) {
        this.prevRaw[i] = this.prevOut[i] = raw;
        continue;
      }
      this.since[i] += dt;
      const jump = Math.abs(raw - this.prevRaw[i]);
      const snapped = this.auto[i] && this.since[i] > INERTIA.holdoffS && jump > Math.max(INERTIA.minJumpRad, INERTIA.jumpSpeeds * this.noLoad[i] * dt);
      if (this.pending[i] || snapped) {
        // New source: start from the pose the servo was being sent to. (Its rate is not carried
        // over: the new source's own rate is unknown on the tick it takes over.)
        this.x[i] = clamp(this.prevOut[i] - raw, -INERTIA.maxOffsetRad, INERTIA.maxOffsetRad);
        this.v[i] = 0;
        this.pending[i] = 0;
        this.since[i] = 0;
        this.switches++;
      }
      const x0 = this.x[i], v0 = this.v[i];
      if (x0 !== 0 || v0 !== 0) {
        const k = v0 + w * x0;
        this.x[i] = (x0 + k * dt) * decay;
        this.v[i] = (v0 - w * k * dt) * decay;
        if (Math.abs(this.x[i]) < 1e-5 && Math.abs(this.v[i]) < 1e-4) this.x[i] = this.v[i] = 0;
      }
      const out = raw + this.x[i];
      this.outVel[i] = (out - this.prevOut[i]) / dt;
      this.prevRaw[i] = raw;
      this.prevOut[i] = out;
      q[i] = out;
    }
  }
}
