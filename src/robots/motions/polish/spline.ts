// Uniform cubic B-splines over clip time, the shape of every polished correction (move-polish.md §2).
// A spline with `n` segments of width `h` has n + 3 control points per channel; segment j
// (τ ∈ [j·h, (j+1)·h)) blends points j..j+3:
//   B0 = (1 − u)³/6   B1 = (3u³ − 6u² + 4)/6   B2 = (−3u³ + 3u² + 3u + 1)/6   B3 = u³/6
// so the curve is C2 (smooth to the second derivative) and point i only acts on τ ∈ [(i−3)·h, (i+1)·h).
// Past the last segment the curve holds its end value with zero slope (the tail is part of the spline
// anyway: the optimiser covers the move plus its settle tail). No allocation per call.

export interface SplineEval {
  /** Index of the first control point in use (the segment). */
  seg: number;
  /** Basis weights for points seg..seg+3, and their first and second derivatives per second. */
  w: Float64Array;
  dw: Float64Array;
  ddw: Float64Array;
}

export function newSplineEval(): SplineEval {
  return { seg: 0, w: new Float64Array(4), dw: new Float64Array(4), ddw: new Float64Array(4) };
}

/** Basis of segment and weights at clip time `tau` for a spline of `n` segments of width `h`. */
export function splineBasis(tau: number, h: number, n: number, out: SplineEval): SplineEval {
  let x = tau / h;
  let held = false;
  if (x < 0) {
    x = 0;
    held = true;
  } else if (x >= n) {
    x = n;
    held = true;
  }
  let seg = Math.floor(x);
  if (seg >= n) seg = n - 1;
  const u = x - seg;
  const u2 = u * u, u3 = u2 * u;
  const w = out.w, dw = out.dw, ddw = out.ddw;
  w[0] = (1 - u) * (1 - u) * (1 - u) / 6;
  w[1] = (3 * u3 - 6 * u2 + 4) / 6;
  w[2] = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6;
  w[3] = u3 / 6;
  if (held) {
    dw.fill(0);
    ddw.fill(0);
  } else {
    const k1 = 1 / h, k2 = 1 / (h * h);
    dw[0] = (-(1 - u) * (1 - u) / 2) * k1;
    dw[1] = ((9 * u2 - 12 * u) / 6) * k1;
    dw[2] = ((-9 * u2 + 6 * u + 3) / 6) * k1;
    dw[3] = (u2 / 2) * k1;
    ddw[0] = (1 - u) * k2;
    ddw[1] = (3 * u - 2) * k2;
    ddw[2] = (-3 * u + 1) * k2;
    ddw[3] = u * k2;
  }
  out.seg = seg;
  return out;
}

/**
 * Value of channel `c` of a spline whose control points are stored point-major:
 * points[i * stride + c] (i = 0..n+2).
 */
export function splineValue(points: ArrayLike<number>, stride: number, c: number, e: SplineEval): number {
  const o = e.seg * stride + c;
  return e.w[0] * points[o] + e.w[1] * points[o + stride] + e.w[2] * points[o + 2 * stride] + e.w[3] * points[o + 3 * stride];
}

export function splineSlope(points: ArrayLike<number>, stride: number, c: number, e: SplineEval): number {
  const o = e.seg * stride + c;
  return e.dw[0] * points[o] + e.dw[1] * points[o + stride] + e.dw[2] * points[o + 2 * stride] + e.dw[3] * points[o + 3 * stride];
}

/** Third derivative of channel c in segment j (constant over the segment), per s³. */
export function splineJerk(points: ArrayLike<number>, stride: number, c: number, j: number, h: number): number {
  const o = j * stride + c;
  // d³/du³ of the basis: −1, 3, −3, 1
  return (-points[o] + 3 * points[o + stride] - 3 * points[o + 2 * stride] + points[o + 3 * stride]) / (h * h * h);
}

/** Piecewise-linear knot channel (rates, gyro feed-forward): value at clip time tau, knots every h, held past the ends. */
export function knotValue(knots: ArrayLike<number>, stride: number, c: number, tau: number, h: number): number {
  const n = knots.length / stride;
  const x = tau / h;
  if (x <= 0) return knots[c];
  if (x >= n - 1) return knots[(n - 1) * stride + c];
  const i = Math.floor(x), w = x - i;
  return knots[i * stride + c] * (1 - w) + knots[(i + 1) * stride + c] * w;
}
