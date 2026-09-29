// Trauma-based camera shake: impacts add trauma, trauma decays, the offset scales with
// trauma² so small taps barely move the frame and a haymaker rattles it. On top of that, a
// landed hit kicks the camera along the impact normal (the direction the victim was driven):
// a short, sharp, damped jolt, so the frame itself feels the blow land.
import { HIT } from '../vfx/scaling';

export const SHAKE = {
  MAX_OFFSET_M: 0.14,
  DECAY_PER_S: 1.5,
  FREQ_HZ: 17,
  ENERGY_FULL_J: 900, // an impact this big adds MAX_PER_HIT trauma
  MAX_PER_HIT: 0.75,
  STRENGTH_TRAUMA: 0.5, // trauma a full-strength landed hit adds (× strength²)
  KICK_M: 0.055, // peak jolt along the impact normal at full strength
  KICK_HZ: 13,
  KICK_DECAY_PER_S: 17,
  MAX_KICKS: 4,
} as const;

interface Kick {
  dir: [number, number, number];
  amp: number;
  t: number;
}

export class CameraShake {
  trauma = 0;
  private t = 0;
  private phases: number[];
  private kicks: Kick[] = [];

  constructor(rng: () => number = Math.random) {
    this.phases = Array.from({ length: 8 }, () => rng() * Math.PI * 2);
  }

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /**
   * A directional jolt along `dir` (physics frame, any length) for a hit of strength 0..1:
   * the frame snaps the way the blow drove the victim, then rings out in ~0.2 s.
   */
  kick(dir: readonly [number, number, number], strength: number): void {
    if (strength < HIT.MIN) return;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-6) return;
    const amp = SHAKE.KICK_M * Math.min(1, strength) ** 1.5;
    if (this.kicks.length >= SHAKE.MAX_KICKS) this.kicks.shift();
    this.kicks.push({ dir: [dir[0] / len, dir[1] / len, dir[2] / len], amp, t: 0 });
  }

  /** Trauma for a landed hit of strength 0..1 (vfx/scaling hitStrength). */
  static forStrength(strength: number): number {
    return strength < HIT.MIN ? 0 : SHAKE.STRENGTH_TRAUMA * Math.min(1, strength) ** 2;
  }

  /** Trauma for an impact of `energyJ` joules. */
  static forEnergy(energyJ: number): number {
    return Math.min(SHAKE.MAX_PER_HIT, Math.sqrt(Math.max(0, energyJ) / SHAKE.ENERGY_FULL_J) * SHAKE.MAX_PER_HIT);
  }

  /** Advance and return an offset (metres, x y z in view-agnostic world axes). */
  update(dt: number): [number, number, number] {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - SHAKE.DECAY_PER_S * dt);
    const out = this.kickOffset(dt);
    const k = this.trauma * this.trauma * SHAKE.MAX_OFFSET_M;
    if (k === 0) return out;
    const w = this.t * SHAKE.FREQ_HZ * Math.PI * 2;
    const n = (i: number) => (Math.sin(w * (1 + i * 0.37) + this.phases[i]) + Math.sin(w * (0.53 + i * 0.21) + this.phases[i + 4]) * 0.5) / 1.5;
    return [out[0] + n(0) * k, out[1] + n(1) * k, out[2] + n(2) * k * 0.6];
  }

  /** Sum of the live directional jolts: starts at full displacement, damped cosine. */
  private kickOffset(dt: number): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    if (!this.kicks.length) return out;
    for (const kk of this.kicks) {
      kk.t += dt;
      const a = kk.amp * Math.exp(-SHAKE.KICK_DECAY_PER_S * kk.t) * Math.cos(2 * Math.PI * SHAKE.KICK_HZ * kk.t);
      out[0] += kk.dir[0] * a;
      out[1] += kk.dir[1] * a;
      out[2] += kk.dir[2] * a;
    }
    this.kicks = this.kicks.filter((kk) => kk.amp * Math.exp(-SHAKE.KICK_DECAY_PER_S * kk.t) > 1e-4);
    return out;
  }
}
