// Separable CMA-ES (Ros & Hansen 2008: diagonal covariance, learning rates × (n+2)/3) with box bounds
// (Lamarckian repair: a candidate is clamped into the box and the step recomputed from it) and a
// per-dimension initial step. IPOP restarts are the caller's: a new SepCMA with twice the population.
import { Rng } from './world';

export interface CmaOptions {
  mean: Float64Array;
  /** Initial step per dimension (absolute units). */
  sigma0: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  lambda?: number;
  seed?: number;
}

export class SepCMA {
  readonly n: number;
  readonly lambda: number;
  readonly mu: number;
  readonly weights: Float64Array;
  readonly mueff: number;
  readonly cs: number;
  readonly ds: number;
  readonly cc: number;
  readonly c1: number;
  readonly cmu: number;
  readonly chiN: number;
  mean: Float64Array;
  sigma = 1;
  readonly scale: Float64Array;
  readonly C: Float64Array; // diagonal covariance (normalised units)
  readonly pc: Float64Array;
  readonly ps: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  gen = 0;
  bestX: Float64Array;
  bestF = Infinity;
  private rng: Rng;
  private ys: Float64Array[] = [];

  constructor(o: CmaOptions) {
    const n = o.mean.length;
    this.n = n;
    this.lambda = o.lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const w = new Float64Array(this.mu);
    for (let i = 0; i < this.mu; i++) w[i] = Math.log(this.mu + 0.5) - Math.log(i + 1);
    const sw = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < this.mu; i++) w[i] /= sw;
    this.weights = w;
    this.mueff = 1 / w.reduce((a, b) => a + b * b, 0);
    const me = this.mueff;
    this.cs = (me + 2) / (n + me + 5);
    this.ds = 1 + 2 * Math.max(0, Math.sqrt((me - 1) / (n + 1)) - 1) + this.cs;
    this.cc = (4 + me / n) / (n + 4 + (2 * me) / n);
    const c1 = 2 / ((n + 1.3) ** 2 + me);
    const cmu = Math.min(1 - c1, (2 * (me - 2 + 1 / me)) / ((n + 2) ** 2 + me));
    const k = (n + 2) / 3;
    let c1s = c1 * k, cmus = cmu * k;
    if (c1s + cmus > 0.95) {
      const f = 0.95 / (c1s + cmus);
      c1s *= f;
      cmus *= f;
    }
    this.c1 = c1s;
    this.cmu = cmus;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = Float64Array.from(o.mean);
    this.scale = Float64Array.from(o.sigma0);
    this.C = new Float64Array(n).fill(1);
    this.pc = new Float64Array(n);
    this.ps = new Float64Array(n);
    this.lo = o.lo;
    this.hi = o.hi;
    this.bestX = Float64Array.from(o.mean);
    this.rng = new Rng(o.seed ?? 12345);
  }

  private gauss(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.rng.next();
    v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** λ candidates, clamped into the box. */
  ask(): Float64Array[] {
    const out: Float64Array[] = [];
    this.ys = [];
    for (let k = 0; k < this.lambda; k++) {
      const x = new Float64Array(this.n);
      const y = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const d = Math.sqrt(this.C[i]);
        let xi = this.mean[i] + this.sigma * this.scale[i] * d * this.gauss();
        xi = Math.max(this.lo[i], Math.min(this.hi[i], xi));
        x[i] = xi;
        y[i] = (xi - this.mean[i]) / (this.sigma * this.scale[i]);
      }
      out.push(x);
      this.ys.push(y);
    }
    return out;
  }

  /** Update from the fitness of the candidates ask() returned (lower is better). */
  tell(xs: Float64Array[], fs: number[]): void {
    const n = this.n;
    const order = fs.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    if (fs[order[0]] < this.bestF) {
      this.bestF = fs[order[0]];
      this.bestX = Float64Array.from(xs[order[0]]);
    }
    const yw = new Float64Array(n);
    for (let k = 0; k < this.mu; k++) {
      const y = this.ys[order[k]];
      for (let i = 0; i < n; i++) yw[i] += this.weights[k] * y[i];
    }
    for (let i = 0; i < n; i++) this.mean[i] = Math.max(this.lo[i], Math.min(this.hi[i], this.mean[i] + this.sigma * this.scale[i] * yw[i]));
    const csn = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    let psn = 0;
    for (let i = 0; i < n; i++) {
      this.ps[i] = (1 - this.cs) * this.ps[i] + csn * (yw[i] / Math.sqrt(this.C[i]));
      psn += this.ps[i] * this.ps[i];
    }
    psn = Math.sqrt(psn);
    this.gen++;
    const hs = psn / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) < (1.4 + 2 / (n + 1)) * this.chiN ? 1 : 0;
    const ccn = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    for (let i = 0; i < n; i++) {
      this.pc[i] = (1 - this.cc) * this.pc[i] + hs * ccn * yw[i];
      let rankMu = 0;
      for (let k = 0; k < this.mu; k++) {
        const y = this.ys[order[k]][i];
        rankMu += this.weights[k] * y * y;
      }
      this.C[i] = (1 - this.c1 - this.cmu) * this.C[i]
        + this.c1 * (this.pc[i] * this.pc[i] + (1 - hs) * this.cc * (2 - this.cc) * this.C[i])
        + this.cmu * rankMu;
      this.C[i] = Math.max(1e-8, Math.min(1e4, this.C[i]));
    }
    this.sigma *= Math.exp((this.cs / this.ds) * (psn / this.chiN - 1));
    this.sigma = Math.min(this.sigma, 3);
  }
}
