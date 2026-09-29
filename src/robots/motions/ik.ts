// Design-agnostic limb IK: damped least squares over one chain of hinge joints, with joint limits
// as projection and the floor as an inequality. Works for any axis order or joint count, so a new
// design needs no new solver.
//
// Tasks (all weighted, stacked into one least-squares problem):
//   pos    a body point reaches a world point
//   dir    a body axis lines up with a world direction (d → t, linearised as δd = δθ × d)
//   floor  a body point (with a radius) stays at or above z = minZ (rows only while violated)
import type { Vec3 } from '../../core/types';
import { clamp, cross, mulMV, sub } from './math';
import { bodyPoint, fkBody, type BodyFrames, type RobotModel } from './robot-model';

export type Task =
  | { kind: 'pos'; body: number; local: Vec3; target: Vec3; w: number }
  | { kind: 'dir'; body: number; local: Vec3; target: Vec3; w: number }
  | { kind: 'floor'; body: number; local: Vec3; radius: number; minZ: number; w: number }
  /** Posture bias: one joint toward an angle (rad), weighted like a distance in metres. */
  | { kind: 'joint'; joint: number; target: number; w: number };

export interface SolveOptions {
  iterations?: number;
  damping?: number;
  tol?: number; // stop when the weighted residual norm falls below this
}

export interface SolveResult {
  residual: number; // weighted residual norm at the end
  iterations: number;
}

interface Row {
  e: number;
  j: Float64Array; // d(row) / d(q_k) per chain joint
}

/** Chain bodies in parent-first order and which chain joints move each body. */
export interface Chain {
  bodies: number[];
  joints: number[];
  moves: Map<number, boolean[]>; // body → per chain joint: does it move this body?
}

export function makeChain(m: RobotModel, bodies: number[]): Chain {
  const joints = bodies.flatMap((b) => m.bodies[b].joints);
  const moves = new Map<number, boolean[]>();
  for (const b of bodies) {
    const anc = new Set<number>();
    for (let x = b; x >= 0; x = m.bodies[x].parent) anc.add(x);
    moves.set(b, joints.map((ji) => anc.has(m.joints[ji].body)));
  }
  return { bodies, joints, moves };
}

function solveSymmetric(A: Float64Array, b: Float64Array, n: number): Float64Array {
  // Gaussian elimination with partial pivoting on a small dense system.
  const M = new Float64Array(A);
  const x = new Float64Array(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = x[c]; x[c] = x[p]; x[p] = t;
    }
    const d = M[c * n + c];
    if (Math.abs(d) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    let s = x[c];
    for (let k = c + 1; k < n; k++) s -= M[c * n + k] * x[k];
    const d = M[c * n + c];
    x[c] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
  return x;
}

function buildRows(m: RobotModel, chain: Chain, f: BodyFrames, q: ArrayLike<number>, tasks: readonly Task[], rows: Row[]): void {
  rows.length = 0;
  const n = chain.joints.length;
  for (const t of tasks) {
    if (t.kind === 'joint') {
      const k = chain.joints.indexOf(t.joint);
      if (k < 0) continue;
      const row: Row = { e: (t.target - q[t.joint]) * t.w, j: new Float64Array(n) };
      row.j[k] = t.w;
      rows.push(row);
      continue;
    }
    const mv = chain.moves.get(t.body);
    if (t.kind === 'pos') {
      const p = bodyPoint(f, t.body, t.local);
      const e = sub(t.target, p);
      for (let a = 0; a < 3; a++) rows.push({ e: e[a] * t.w, j: new Float64Array(n) });
      const base = rows.length - 3;
      for (let k = 0; k < n; k++) {
        if (!mv?.[k]) continue;
        const ji = chain.joints[k];
        const c = cross(f.axis[ji], sub(p, f.pos[m.joints[ji].body]));
        for (let a = 0; a < 3; a++) rows[base + a].j[k] = c[a] * t.w;
      }
    } else if (t.kind === 'dir') {
      const d = mulMV(f.rot[t.body], t.local);
      const e = sub(t.target, d);
      for (let a = 0; a < 3; a++) rows.push({ e: e[a] * t.w, j: new Float64Array(n) });
      const base = rows.length - 3;
      for (let k = 0; k < n; k++) {
        if (!mv?.[k]) continue;
        const c = cross(f.axis[chain.joints[k]], d);
        for (let a = 0; a < 3; a++) rows[base + a].j[k] = c[a] * t.w;
      }
    } else {
      const p = bodyPoint(f, t.body, t.local);
      const gap = t.minZ - (p[2] - t.radius);
      // Active within FLOOR_MARGIN above the mat too (with zero error): a point resting on the
      // floor is held there instead of dropping back through it on the next iteration.
      if (gap <= -FLOOR_MARGIN) continue;
      const row: Row = { e: Math.max(0, gap) * t.w, j: new Float64Array(n) };
      for (let k = 0; k < n; k++) {
        if (!mv?.[k]) continue;
        const ji = chain.joints[k];
        row.j[k] = cross(f.axis[ji], sub(p, f.pos[m.joints[ji].body]))[2] * t.w;
      }
      rows.push(row);
    }
  }
}

/** m: floor rows stay active this far above the mat (see buildRows). */
const FLOOR_MARGIN = 0.01;

const scratchRows: Row[] = [];

/** Weighted residual norm of `tasks` at the current pose (chain bodies must be posed). */
export function residualOf(m: RobotModel, chain: Chain, f: BodyFrames, q: ArrayLike<number>, tasks: readonly Task[]): number {
  buildRows(m, chain, f, q, tasks, scratchRows);
  let r2 = 0;
  for (const r of scratchRows) r2 += r.e * r.e;
  return Math.sqrt(r2);
}

/**
 * Warm-started solve with restarts: a chain dragged into a joint-limit corner by the previous
 * frame can sit in a local minimum there, so when the residual stays above `restartAbove`, solve
 * again from each seed (angles per chain joint) and keep the best. A restart is a jump to another
 * IK branch, which a servo cannot follow in one frame: it must beat the warm start by `jumpGain`
 * (fraction of the warm residual) to be taken.
 */
export function solveChainRobust(
  m: RobotModel, chain: Chain, f: BodyFrames, q: Float64Array, tasks: readonly Task[],
  seeds: ReadonlyArray<ArrayLike<number>>, restartAbove: number, opts: SolveOptions & { jumpGain?: number } = {},
): number {
  solveChain(m, chain, f, q, tasks, opts);
  const warm = residualOf(m, chain, f, q, tasks);
  if (warm <= restartAbove) return warm;
  let best = warm;
  let keep = chain.joints.map((j) => q[j]);
  const gain = opts.jumpGain ?? 0.5;
  for (const seed of seeds) {
    chain.joints.forEach((j, k) => { q[j] = seed[k]; });
    solveChain(m, chain, f, q, tasks, opts);
    const r = residualOf(m, chain, f, q, tasks);
    if (r < best - 1e-4 && r < warm * (1 - gain)) {
      best = r;
      keep = chain.joints.map((j) => q[j]);
    }
  }
  chain.joints.forEach((j, k) => { q[j] = keep[k]; });
  for (const b of chain.bodies) fkBody(m, b, q, f);
  return best;
}

/**
 * Damped least-squares step with joint limits as an active set: a joint already on a limit that
 * the step pushes further out is locked (its column dropped) and the step re-solved, so the other
 * joints make up for it in the same iteration instead of stalling against the clamp.
 */
function solveWithLimits(A: Float64Array, g: Float64Array, n: number, chain: Chain, m: RobotModel, q: ArrayLike<number>): Float64Array {
  const locked = new Uint8Array(n);
  let dq = solveSymmetric(A, g, n);
  for (let pass = 0; pass < n; pass++) {
    let more = false;
    for (let k = 0; k < n; k++) {
      if (locked[k]) continue;
      const j = m.joints[chain.joints[k]], v = q[chain.joints[k]];
      if ((v <= j.solveLo + LIMIT_EPS && dq[k] < 0) || (v >= j.solveHi - LIMIT_EPS && dq[k] > 0)) {
        locked[k] = 1;
        more = true;
      }
    }
    if (!more) break;
    const Al = new Float64Array(A), gl = new Float64Array(g);
    for (let k = 0; k < n; k++) {
      if (!locked[k]) continue;
      for (let c = 0; c < n; c++) {
        Al[k * n + c] = 0;
        Al[c * n + k] = 0;
      }
      Al[k * n + k] = 1;
      gl[k] = 0;
    }
    dq = solveSymmetric(Al, gl, n);
  }
  return dq;
}

/** rad: a joint this close to a limit counts as on it. */
const LIMIT_EPS = 1e-6;

/**
 * Solve one chain in place: `q` (indexed like m.joints) is the warm start and the result; `f`
 * must hold the posed frame of the chain's base body and is left posed at the solution.
 */
export function solveChain(m: RobotModel, chain: Chain, f: BodyFrames, q: Float64Array, tasks: readonly Task[], opts: SolveOptions = {}): SolveResult {
  const iters = opts.iterations ?? 40;
  const lambda2 = (opts.damping ?? 0.02) ** 2;
  const tol = opts.tol ?? 5e-4;
  const n = chain.joints.length;
  const A = new Float64Array(n * n);
  const g = new Float64Array(n);
  let residual = Infinity;
  let it = 0;
  for (; it < iters; it++) {
    for (const b of chain.bodies) fkBody(m, b, q, f);
    buildRows(m, chain, f, q, tasks, scratchRows);
    let r2 = 0;
    for (const r of scratchRows) r2 += r.e * r.e;
    residual = Math.sqrt(r2);
    if (residual < tol) break;
    A.fill(0);
    g.fill(0);
    for (const r of scratchRows) {
      for (let a = 0; a < n; a++) {
        const ja = r.j[a];
        if (ja === 0) continue;
        g[a] += ja * r.e;
        for (let b = 0; b < n; b++) A[a * n + b] += ja * r.j[b];
      }
    }
    for (let a = 0; a < n; a++) A[a * n + a] += lambda2;
    const dq = solveWithLimits(A, g, n, chain, m, q);
    let step = 0;
    for (let k = 0; k < n; k++) {
      const ji = chain.joints[k];
      const j = m.joints[ji];
      const next = clamp(q[ji] + dq[k], j.solveLo, j.solveHi);
      step = Math.max(step, Math.abs(next - q[ji]));
      q[ji] = next;
    }
    if (step < 1e-6) break;
  }
  for (const b of chain.bodies) fkBody(m, b, q, f);
  return { residual, iterations: it };
}
