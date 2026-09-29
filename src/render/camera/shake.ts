// Trauma-based camera shake: impacts add trauma, trauma decays, the offset scales with
// trauma² so small taps barely move the frame and a haymaker rattles it.

export const SHAKE = {
  MAX_OFFSET_M: 0.14,
  DECAY_PER_S: 1.5,
  FREQ_HZ: 17,
  ENERGY_FULL_J: 900, // an impact this big adds MAX_PER_HIT trauma
  MAX_PER_HIT: 0.75,
} as const;

export class CameraShake {
  trauma = 0;
  private t = 0;
  private phases: number[];

  constructor(rng: () => number = Math.random) {
    this.phases = Array.from({ length: 8 }, () => rng() * Math.PI * 2);
  }

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /** Trauma for an impact of `energyJ` joules. */
  static forEnergy(energyJ: number): number {
    return Math.min(SHAKE.MAX_PER_HIT, Math.sqrt(Math.max(0, energyJ) / SHAKE.ENERGY_FULL_J) * SHAKE.MAX_PER_HIT);
  }

  /** Advance and return an offset (metres, x y z in view-agnostic world axes). */
  update(dt: number): [number, number, number] {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - SHAKE.DECAY_PER_S * dt);
    const k = this.trauma * this.trauma * SHAKE.MAX_OFFSET_M;
    if (k === 0) return [0, 0, 0];
    const w = this.t * SHAKE.FREQ_HZ * Math.PI * 2;
    const n = (i: number) => (Math.sin(w * (1 + i * 0.37) + this.phases[i]) + Math.sin(w * (0.53 + i * 0.21) + this.phases[i + 4]) * 0.5) / 1.5;
    return [n(0) * k, n(1) * k, n(2) * k * 0.6];
  }
}
