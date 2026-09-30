// The DCM reference (docs/design/balance-engine.md §3.2). The centroidal moment pivot (CMP) plan is
// piecewise linear in time: on each sole it rolls heel to toe (or sits on the ball), and through
// double support it slides from one foot to the next, so the planned pressure point never jumps.
// The divergent component of motion ξ that stays bounded under that plan solves ξ̇ = ω(ξ − r):
//
//   ξ(t) = r(t) + ṙ/ω + (ξ_{k+1} − r_{k+1} − ṙ/ω)·e^{ω(t − t_{k+1})}      on [t_k, t_{k+1}]
//
// solved backward from the last knot (Englsberger 2013's recursion, with linear instead of
// constant CMP segments, which is what keeps leg forces continuous through double support). The
// last knot holds its CMP for good; ξ there is that CMP plus an optional terminal offset (a walk
// that goes on past the planning horizon keeps ξ ahead of its last foothold).
//
// Allocation free: a plan is refilled in place at every footstep event and evaluated every tick.
import type { P2 } from '../support';

export const MAX_KNOTS = 40;

export interface DcmSample {
  xi: P2; // ξ_ref(t)
  r: P2; // r_ref(t)
  rd: P2; // ṙ_ref(t)
}

export function newDcmSample(): DcmSample {
  return { xi: [0, 0], r: [0, 0], rd: [0, 0] };
}

export class DcmPlan {
  n = 0;
  omega = 3.3;
  readonly t = new Float64Array(MAX_KNOTS);
  readonly rx = new Float64Array(MAX_KNOTS);
  readonly ry = new Float64Array(MAX_KNOTS);
  /** ξ at each knot (filled by solve). */
  readonly xx = new Float64Array(MAX_KNOTS);
  readonly xy = new Float64Array(MAX_KNOTS);

  clear(): void {
    this.n = 0;
  }

  /** Append a knot: the CMP is at (x, y) at time t. A knot at (almost) the same time replaces the last. */
  add(t: number, x: number, y: number): void {
    const n = this.n;
    if (n > 0 && t <= this.t[n - 1] + 1e-4) {
      this.rx[n - 1] = x;
      this.ry[n - 1] = y;
      return;
    }
    if (n >= MAX_KNOTS) return;
    this.t[n] = t;
    this.rx[n] = x;
    this.ry[n] = y;
    this.n = n + 1;
  }

  /** Backward recursion. (termX, termY): ξ at the last knot relative to its CMP (0: come to rest). */
  solve(omega: number, termX = 0, termY = 0): void {
    this.omega = omega;
    const n = this.n;
    if (n === 0) return;
    this.xx[n - 1] = this.rx[n - 1] + termX;
    this.xy[n - 1] = this.ry[n - 1] + termY;
    for (let k = n - 2; k >= 0; k--) {
      const T = this.t[k + 1] - this.t[k];
      const e = Math.exp(-omega * T);
      const vx = (this.rx[k + 1] - this.rx[k]) / T, vy = (this.ry[k + 1] - this.ry[k]) / T;
      this.xx[k] = this.rx[k] + vx / omega + (this.xx[k + 1] - this.rx[k + 1] - vx / omega) * e;
      this.xy[k] = this.ry[k] + vy / omega + (this.xy[k + 1] - this.ry[k + 1] - vy / omega) * e;
    }
  }

  /** ξ_ref, r_ref and ṙ_ref at `time`. */
  sample(time: number, out: DcmSample): DcmSample {
    const n = this.n, w = this.omega;
    if (n === 0) return out;
    if (time <= this.t[0] || n === 1) {
      // Before the first knot (or a one-knot plan): the CMP holds its first value.
      const e = Math.exp(w * (time - this.t[0]));
      out.r[0] = this.rx[0];
      out.r[1] = this.ry[0];
      out.rd[0] = out.rd[1] = 0;
      out.xi[0] = this.rx[0] + (this.xx[0] - this.rx[0]) * e;
      out.xi[1] = this.ry[0] + (this.xy[0] - this.ry[0]) * e;
      return out;
    }
    if (time >= this.t[n - 1]) {
      const e = Math.exp(w * (time - this.t[n - 1]));
      out.r[0] = this.rx[n - 1];
      out.r[1] = this.ry[n - 1];
      out.rd[0] = out.rd[1] = 0;
      out.xi[0] = this.rx[n - 1] + (this.xx[n - 1] - this.rx[n - 1]) * e;
      out.xi[1] = this.ry[n - 1] + (this.xy[n - 1] - this.ry[n - 1]) * e;
      return out;
    }
    let k = 0;
    while (k < n - 2 && time >= this.t[k + 1]) k++;
    const T = this.t[k + 1] - this.t[k];
    const vx = (this.rx[k + 1] - this.rx[k]) / T, vy = (this.ry[k + 1] - this.ry[k]) / T;
    const u = time - this.t[k];
    const e = Math.exp(w * (time - this.t[k + 1]));
    out.r[0] = this.rx[k] + vx * u;
    out.r[1] = this.ry[k] + vy * u;
    out.rd[0] = vx;
    out.rd[1] = vy;
    out.xi[0] = out.r[0] + vx / w + (this.xx[k + 1] - this.rx[k + 1] - vx / w) * e;
    out.xi[1] = out.r[1] + vy / w + (this.xy[k + 1] - this.ry[k + 1] - vy / w) * e;
    return out;
  }

  /**
   * Re-choose the first knot's CMP so that ξ(t₀) equals `xi` (a plan starting from the body as it
   * is: the first segment carries the correction), kept inside `clampTo`. Call after solve().
   */
  connect(xi: readonly [number, number], clampTo: (p: [number, number]) => [number, number]): void {
    if (this.n < 2) return;
    const w = this.omega;
    const T = this.t[1] - this.t[0];
    if (T < 0.05) return;
    const k = 1 / (w * T), E = Math.exp(-w * T);
    const a = 1 - k + k * E, b = k - E - k * E;
    if (a < 0.05) return;
    const r: [number, number] = [
      (xi[0] - this.rx[1] * b - this.xx[1] * E) / a,
      (xi[1] - this.ry[1] * b - this.xy[1] * E) / a,
    ];
    const c = clampTo(r);
    this.rx[0] = c[0];
    this.ry[0] = c[1];
    const vx = (this.rx[1] - this.rx[0]) / T, vy = (this.ry[1] - this.ry[0]) / T;
    this.xx[0] = this.rx[0] + vx / w + (this.xx[1] - this.rx[1] - vx / w) * E;
    this.xy[0] = this.ry[0] + vy / w + (this.xy[1] - this.ry[1] - vy / w) * E;
  }

  /** The planned CMP at `time` (no ξ). */
  cmpAt(time: number, out: P2): P2 {
    const n = this.n;
    if (n === 0) return out;
    if (time <= this.t[0] || n === 1) {
      out[0] = this.rx[0];
      out[1] = this.ry[0];
      return out;
    }
    if (time >= this.t[n - 1]) {
      out[0] = this.rx[n - 1];
      out[1] = this.ry[n - 1];
      return out;
    }
    let k = 0;
    while (k < n - 2 && time >= this.t[k + 1]) k++;
    const a = (time - this.t[k]) / (this.t[k + 1] - this.t[k]);
    out[0] = this.rx[k] + (this.rx[k + 1] - this.rx[k]) * a;
    out[1] = this.ry[k] + (this.ry[k + 1] - this.ry[k]) * a;
    return out;
  }
}
