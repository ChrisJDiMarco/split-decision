// Kinematic warm start (before any rollout): every foot the clip marks as planted is turned flat on the
// canvas with its own ankle pitch and roll, so the leg above keeps the clip's pose. The retargeted clips
// stand planted soles on an edge (SAVATE's cross: the lead sole 7-13° off flat all through the move),
// which no servo playback can balance on. Only ankle Δq is set; the search refines everything after.
import { sample } from '../../src/robots/motions';
import { KNOT_S, type PlanState } from './plan';
import { FOOT_BITS, intoHull, poseQpos, refContacts } from './reference';
import type { MoveSession } from './session';

const MAX_FLATTEN = 0.35;
/** How far inside the support the warm start puts the COM (or the support's middle when it is thinner). */
export const STANCE_MARGIN_M = 0.045;

export function flattenPlantedFeet(ses: MoveSession, plan: PlanState): { points: number; maxDeg: number } {
  const { w, spec } = ses;
  const move = spec.move;
  const model = w.ctx.model;
  const d = new w.mj.MjData(model);
  const qpos = new Float64Array(model.nq);
  const nl = spec.nLib;
  const ankle = (side: 'l' | 'r', kind: 'pitch' | 'roll') => {
    const name = `ankle_${kind}_${side}`;
    const ri = w.r.joints.findIndex((j) => j.name === name);
    return { ri, lib: w.joints[ri].lib, jnt: w.ids.jnt[ri] };
  };
  const sides = (['l', 'r'] as const).map((s) => ({ pitch: ankle(s, 'pitch'), roll: ankle(s, 'roll') }));
  let n = 0, maxDeg = 0;
  for (let i = 0; i < spec.segments + 3; i++) {
    const tau = Math.max(0, Math.min(move.duration, (i - 1) * KNOT_S));
    const bits = refContacts(ses.ref, tau);
    poseQpos(w, move, tau, ses.place, qpos);
    (d.qpos as Float64Array).set(qpos);
    w.mj.mj_kinematics(model, d);
    const gm = d.geom_xmat as Float64Array, xa = d.xaxis as Float64Array;
    for (let f = 0; f < 2; f++) {
      if (!(bits & FOOT_BITS[f])) continue;
      const g = w.ids.footGeom[f];
      // Sole normal (geom z axis) and the rotation that makes it vertical: θ = u × ẑ.
      const ux = gm[g * 9 + 2], uy = gm[g * 9 + 5], uz = gm[g * 9 + 8];
      const th = [uy, -ux, 0];
      void uz;
      const ap = [xa[sides[f].pitch.jnt * 3], xa[sides[f].pitch.jnt * 3 + 1], xa[sides[f].pitch.jnt * 3 + 2]];
      const ar = [xa[sides[f].roll.jnt * 3], xa[sides[f].roll.jnt * 3 + 1], xa[sides[f].roll.jnt * 3 + 2]];
      // Least squares: Δp·a_p + Δr·a_r ≈ θ.
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const A = dot(ap, ap), B = dot(ap, ar), C = dot(ar, ar), det = A * C - B * B;
      if (Math.abs(det) < 1e-6) continue;
      const bp = dot(ap, th), br = dot(ar, th);
      const dp = Math.max(-MAX_FLATTEN, Math.min(MAX_FLATTEN, (C * bp - B * br) / det));
      const dr = Math.max(-MAX_FLATTEN, Math.min(MAX_FLATTEN, (A * br - B * bp) / det));
      plan.dq[i * nl + sides[f].pitch.lib] = dp;
      plan.dq[i * nl + sides[f].roll.lib] = dr;
      maxDeg = Math.max(maxDeg, Math.hypot(dp, dr) * 57.3);
      n++;
    }
  }
  d.delete();
  return { points: n, maxDeg };
}

/**
 * Mass-aware stance (balance-engine.md §5.1, kinematically): at every knot where the clip stands on its
 * feet only, the robot's COM (heavier limbs than the actor's) is moved into the support of the soles
 * touching the canvas, STANCE_MARGIN_M inside, by the legs and waist with the planted soles held where they are
 * (damped least squares on MuJoCo's own Jacobians). Only Δq of legs and waist changes.
 */
export function centerMassOverFeet(ses: MoveSession, plan: PlanState): { points: number; maxShiftCm: number } {
  const { w, spec } = ses;
  const move = spec.move;
  const model = w.ctx.model;
  const mj = w.mj;
  const nv = model.nv as number;
  const d = new mj.MjData(model);
  const jp = new mj.DoubleBuffer(3 * nv), jr = new mj.DoubleBuffer(3 * nv), jc = new mj.DoubleBuffer(3 * nv);
  const qpos = new Float64Array(model.nq);
  const nl = spec.nLib;
  const r = w.r;
  // Unknowns: the floating base (6) + legs and waist.
  const dofs: number[] = [0, 1, 2, 3, 4, 5].map((k) => r.rootDadr + k);
  const jointsUsed: number[] = [];
  r.joints.forEach((j, i) => {
    if (/^(hip_|knee_|ankle_|waist_)/.test(j.name)) {
      dofs.push(j.dadr);
      jointsUsed.push(i);
    }
  });
  const n = dofs.length;
  let pts = 0, maxShift = 0;
  for (let i = 0; i < spec.segments + 3; i++) {
    const tau = Math.max(0, Math.min(move.duration, (i - 1) * KNOT_S));
    const smp = sample(move, tau, { speed: 1, loop: false });
    const bits = refContacts(ses.ref, tau);
    const planted = [0, 1].filter((f) => bits & FOOT_BITS[f]);
    if (!planted.length || (bits & ~3) !== 0) continue; // feet only
    poseQpos(w, move, tau, ses.place, qpos);
    // Start from the current correction at this knot (the flattened ankles).
    r.joints.forEach((j, ri) => {
      const ch = w.joints[ri].lib;
      if (ch >= 0) qpos[j.qadr] += plan.dq[i * nl + ch];
    });
    (d.qpos as Float64Array).set(qpos);
    mj.mj_kinematics(model, d);
    mj.mj_comPos(model, d);
    // Support: sole corners within 2.5 cm of the canvas.
    const gx = d.geom_xpos as Float64Array, gm = d.geom_xmat as Float64Array;
    const corners: Array<[number, number]> = [];
    for (let f = 0; f < 2; f++) {
      const g = w.ids.footGeom[f], o = g * 9;
      const [hx, hy, hz] = w.footHalf;
      for (const [ax, ay] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
        const z = gx[g * 3 + 2] + gm[o + 6] * ax + gm[o + 7] * ay - gm[o + 8] * hz;
        if (z < 0.025) corners.push([gx[g * 3] + gm[o] * ax + gm[o + 1] * ay - gm[o + 2] * hz, gx[g * 3 + 1] + gm[o + 3] * ax + gm[o + 4] * ay - gm[o + 5] * hz]);
      }
    }
    if (corners.length < 3) continue;
    const sc = d.subtree_com as Float64Array;
    const com0: [number, number] = [sc[w.ids.root * 3], sc[w.ids.root * 3 + 1]];
    const goal = intoHull(corners, com0, STANCE_MARGIN_M);
    const shift = Math.hypot(goal[0] - com0[0], goal[1] - com0[1]);
    if (shift < 0.003) continue;
    // Planted soles to hold (position and orientation of the foot bodies).
    const hold = planted.map((f) => {
      const b = w.ids.foot[f];
      return { b, p: [0, 1, 2].map((k) => (d.xpos as Float64Array)[b * 3 + k]), R: Array.from((d.xmat as Float64Array).slice(b * 9, b * 9 + 9)) };
    });
    for (let it = 0; it < 8; it++) {
      mj.mj_kinematics(model, d);
      mj.mj_comPos(model, d);
      const rows: number[][] = [];
      const rhs: number[] = [];
      const wts: number[] = [];
      mj.mj_jacSubtreeCom(model, d, jc, w.ids.root);
      const JC = jc.GetView() as Float64Array;
      const scom = d.subtree_com as Float64Array;
      for (let k = 0; k < 2; k++) {
        rows.push(dofs.map((dof) => JC[k * nv + dof]));
        rhs.push(goal[k] - scom[w.ids.root * 3 + k]);
        wts.push(1);
      }
      for (const h of hold) {
        mj.mj_jacBody(model, d, jp, jr, h.b);
        const JP = jp.GetView() as Float64Array, JR = jr.GetView() as Float64Array;
        const xp = d.xpos as Float64Array, xm = d.xmat as Float64Array;
        // Orientation error: rotation taking the current frame to the held one (small angle, world).
        const R = Array.from(xm.slice(h.b * 9, h.b * 9 + 9));
        const E = [0, 1, 2].map((a) => [0, 1, 2].map((b2) => h.R[a * 3] * R[b2 * 3] + h.R[a * 3 + 1] * R[b2 * 3 + 1] + h.R[a * 3 + 2] * R[b2 * 3 + 2]));
        const rot = [(E[2][1] - E[1][2]) / 2, (E[0][2] - E[2][0]) / 2, (E[1][0] - E[0][1]) / 2];
        for (let k = 0; k < 3; k++) {
          rows.push(dofs.map((dof) => JP[k * nv + dof]));
          rhs.push(h.p[k] - xp[h.b * 3 + k]);
          wts.push(100);
          rows.push(dofs.map((dof) => JR[k * nv + dof]));
          rhs.push(rot[k]);
          wts.push(30);
        }
      }
      const dv = dampedSolve(rows, rhs, wts, n, 1e-3);
      // Integrate: hinge joints add, the free joint's position adds, its quaternion turns by the
      // body-frame angular step.
      const q = d.qpos as Float64Array;
      q[r.rootQadr] += dv[0];
      q[r.rootQadr + 1] += dv[1];
      q[r.rootQadr + 2] += dv[2];
      const wq = [dv[3], dv[4], dv[5]];
      const ang = Math.hypot(wq[0], wq[1], wq[2]);
      if (ang > 1e-12) {
        const s = Math.sin(ang / 2) / ang;
        const dq = [Math.cos(ang / 2), wq[0] * s, wq[1] * s, wq[2] * s];
        const a = [q[r.rootQadr + 3], q[r.rootQadr + 4], q[r.rootQadr + 5], q[r.rootQadr + 6]];
        const m = [
          a[0] * dq[0] - a[1] * dq[1] - a[2] * dq[2] - a[3] * dq[3],
          a[0] * dq[1] + a[1] * dq[0] + a[2] * dq[3] - a[3] * dq[2],
          a[0] * dq[2] - a[1] * dq[3] + a[2] * dq[0] + a[3] * dq[1],
          a[0] * dq[3] + a[1] * dq[2] - a[2] * dq[1] + a[3] * dq[0],
        ];
        const nm = Math.hypot(m[0], m[1], m[2], m[3]);
        for (let k = 0; k < 4; k++) q[r.rootQadr + 3 + k] = m[k] / nm;
      }
      jointsUsed.forEach((ri, k) => {
        q[r.joints[ri].qadr] += dv[6 + k];
      });
    }
    // The legs' and waist's new angles become their correction at this knot.
    const q = d.qpos as Float64Array;
    for (const ri of jointsUsed) {
      const ch = w.joints[ri].lib;
      if (ch < 0) continue;
      const v = q[r.joints[ri].qadr] - smp.q[ch];
      plan.dq[i * nl + ch] = Math.max(-0.4, Math.min(0.4, v));
    }
    pts++;
    maxShift = Math.max(maxShift, shift);
  }
  jp.delete();
  jr.delete();
  jc.delete();
  d.delete();
  return { points: pts, maxShiftCm: maxShift * 100 };
}

/** min Σ w_r (J_r·x − b_r)² + λ‖x‖², by the normal equations and Gaussian elimination. */
function dampedSolve(rows: number[][], rhs: number[], wts: number[], n: number, lambda: number): Float64Array {
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  rows.forEach((row, k) => {
    const wk = wts[k];
    for (let a = 0; a < n; a++) {
      if (row[a] === 0) continue;
      for (let b = 0; b < n; b++) A[a][b] += wk * row[a] * row[b];
      A[a][n] += wk * row[a] * rhs[k];
    }
  });
  for (let a = 0; a < n; a++) A[a][a] += lambda;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-12);
  }
  return x;
}
