// Small deterministic optimisers for the Phase 0 searches (seeded; same budget for every variant).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface Box { lo: number[]; hi: number[] }
const clampV = (x: number[], b: Box) => x.map((v, i) => Math.min(b.hi[i], Math.max(b.lo[i], v)));

/** Cross-entropy method, then a shrinking coordinate pattern search from the best point. */
export function minimize(f: (x: number[]) => number, x0: number[], sigma0: number[], box: Box, opts: { iters?: number; pop?: number; elite?: number; seed?: number; refine?: boolean } = {}): { x: number[]; f: number; evals: number } {
  const rng = mulberry32(opts.seed ?? 1);
  const iters = opts.iters ?? 25, pop = opts.pop ?? 32, elite = opts.elite ?? 6;
  let mean = clampV(x0, box), sd = [...sigma0];
  let best = { x: mean, f: f(mean) };
  let evals = 1;
  for (let it = 0; it < iters; it++) {
    const samples: Array<{ x: number[]; f: number }> = [];
    for (let k = 0; k < pop; k++) {
      const x = clampV(mean.map((m, i) => m + sd[i] * gauss(rng)), box);
      samples.push({ x, f: f(x) });
      evals++;
    }
    samples.push(best);
    samples.sort((a, b) => a.f - b.f);
    if (samples[0].f < best.f) best = samples[0];
    const el = samples.slice(0, elite);
    mean = mean.map((_, i) => el.reduce((s, e) => s + e.x[i], 0) / el.length);
    sd = sd.map((_, i) => Math.max(1e-4, 0.3 * sd[i] + 0.7 * Math.sqrt(el.reduce((s, e) => s + (e.x[i] - mean[i]) ** 2, 0) / el.length)));
  }
  if (opts.refine !== false) {
    let x = best.x, fx = best.f, step = sigma0.map((s) => s * 0.25);
    for (let round = 0; round < 40 && step.some((s, i) => s > sigma0[i] * 1e-3); round++) {
      let improved = false;
      for (let i = 0; i < x.length; i++) for (const sg of [1, -1]) {
        const n = clampV(x.map((v, j) => (j === i ? v + sg * step[i] : v)), box);
        const fn = f(n);
        evals++;
        if (fn < fx) { x = n; fx = fn; improved = true; }
      }
      if (!improved) step = step.map((s) => s / 2);
    }
    best = { x, f: fx };
  }
  return { ...best, evals };
}

/** Min-jerk blend 0..1. */
export const minJerk = (t: number) => { const s = Math.min(1, Math.max(0, t)); return s * s * s * (10 - 15 * s + 6 * s * s); };
