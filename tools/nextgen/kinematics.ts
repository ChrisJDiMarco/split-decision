// Phase 0 static measurements (no stepping): mass, leg swing inertia, equal-range IK pose fits,
// reachable kick height, crouched-pivot fits and how close each path runs to a hip gimbal lock.
import { DEG, apply, dot, mul, rAxis, rx, rz, sub, xmatAt, v3At, type V3 } from './math3';
import { fkHip, kickCost, rotCost, solveHip, type HipAngles, type Layout, type Side, pitchAxis, thighDir, kneeAxis } from './hipik';
import { KICKS, elevated, pivotTarget } from './poses';
import { makeVSim, placeJoints, bodyId } from './sim';
import { hipRangesOf, legGeometry, motorOf, type Variant } from './variants';

// ---------------------------------------------------------------- mass and inertia

export async function massAndInertia(v: Variant) {
  const sim = await makeVSim(v, { lift: 0.5 });
  const { ctx } = sim;
  const m = ctx.model, d = ctx.data;
  // Legs straight, everything else at stance.
  const zero: Record<string, number> = {};
  for (const s of ['l', 'r']) for (const j of ['hip_pitch', 'hip_roll', 'hip_yaw', 'knee', 'ankle_pitch', 'ankle_roll']) zero[`${j}_${s}`] = 0;
  placeJoints(sim, zero);
  sim.mj.mj_kinematics(m, d);
  sim.mj.mj_comPos(m, d);
  const nb = m.nbody;
  const children = (b: number) => { const out = [b]; for (let i = 0; i < nb; i++) if (i !== b && m.body_parentid[i] === b) out.push(...children(i)); return out; };
  const inertiaAbout = (jointName: string) => {
    const jid = sim.r.joints[sim.r.jointIndex.get(jointName)!];
    const jIdx = m.actuator_trnid[jid.act * 2];
    const body = m.jnt_bodyid[jIdx];
    const u = v3At(d.xaxis, jIdx), a = v3At(d.xanchor, jIdx);
    let I = 0, mass = 0;
    for (const b of children(body)) {
      const mb = m.body_mass[b];
      mass += mb;
      const R = xmatAt(d.ximat, b);
      const Ib: V3 = [m.body_inertia[b * 3], m.body_inertia[b * 3 + 1], m.body_inertia[b * 3 + 2]];
      const ul = apply([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]], u); // Rᵀu
      I += Ib[0] * ul[0] ** 2 + Ib[1] * ul[1] ** 2 + Ib[2] * ul[2] ** 2;
      const rr = sub(v3At(d.xipos, b), a);
      const perp = sub(rr, [u[0] * dot(rr, u), u[1] * dot(rr, u), u[2] * dot(rr, u)]);
      I += mb * dot(perp, perp);
    }
    return { I, mass };
  };
  const root = sim.r.rootBody;
  const total = m.body_subtreemass[root];
  // Leg = everything below the pelvis on the left side.
  const legBodies = children(bodyId(sim, sim.r.design.parts.find((p) => p.parent === 'pelvis' && p.id.endsWith('_l') && (p.id.startsWith('thigh') || p.id.startsWith('hip_pitch_link')))!.id));
  const legMass = legBodies.reduce((s, b) => s + m.body_mass[b], 0);
  // Drive mass per leg (catalog masses, wherever they ride).
  const legMotors = ['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l', 'ankle_pitch_l', 'ankle_roll_l'].map((n) => motorOf(sim.r.joints[sim.r.jointIndex.get(n)!].motor.id));
  const driveMass = legMotors.reduce((s, x) => s + x.massKg, 0);
  const pitch = inertiaAbout('hip_pitch_l');
  const out = {
    totalMassKg: total,
    legMassKg: legMass,
    legDriveMassKg: driveMass,
    footMassKg: m.body_mass[bodyId(sim, 'foot_l')],
    // Swing inertia about each joint axis through its anchor, straight leg (kg·m²), plus armature.
    inertia: {
      hipPitch: pitch.I,
      hipRoll: inertiaAbout('hip_roll_l').I,
      hipYaw: inertiaAbout('hip_yaw_l').I,
      knee: inertiaAbout('knee_l').I,
    },
    armature: Object.fromEntries(['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l', 'ankle_pitch_l'].map((n) => {
      const j = sim.r.joints[sim.r.jointIndex.get(n)!];
      return [n, m.dof_armature[j.dadr]];
    })),
  };
  sim.dispose();
  return out;
}

// ---------------------------------------------------------------- pose fits

const side: Side = 'l';
const deg = (x: number) => x / DEG;
const angles = (q: HipAngles) => ({ p: +deg(q.p).toFixed(1), r: +deg(q.r).toFixed(1), y: +deg(q.y).toFixed(1) });

export function kickFits(v: Variant) {
  const rng = hipRangesOf(v, side);
  return KICKS.map((k) => {
    const sol = solveHip(v.layout, side, rng, kickCost(k.d, k.k));
    const R = fkHip(v.layout, side, sol.q);
    const dErr = Math.acos(Math.max(-1, Math.min(1, dot(thighDir(R), k.d))));
    const kErr = Math.acos(Math.max(-1, Math.min(1, dot(kneeAxis(R), k.k))));
    return { kick: k.id, errDeg: deg(sol.cost), thighErrDeg: deg(dErr), kneeAxisErrDeg: deg(kErr), q: sol.q, angles: angles(sol.q), sigmaMin: sigmaMin(v.layout, sol.q) };
  });
}

/** Highest thigh elevation (deg above level) whose fit is under tolDeg; ankle height with a straight leg. */
export function reachHeights(v: Variant, tolDeg = 10) {
  const rng = hipRangesOf(v, side);
  const g = legGeometry(v.design);
  const L = g.thighLen + g.shinLen;
  const hipH = L + 0.09 * (g.thighLen / 0.44); // hip above the sole with straight legs (builder: sole→ankle 0.09·scale)
  const out: Record<string, { elevDeg: number; ankleHeightM: number; errAtTopDeg: number }> = {};
  for (const id of ['front', 'side', 'roundhouse'] as const) {
    let best = -90, err = NaN;
    for (let e = -10; e <= 90; e += 2.5) {
      const k = elevated(id, e);
      const sol = solveHip(v.layout, side, rng, kickCost(k.d, k.k), 4);
      if (deg(sol.cost) < tolDeg) { best = e; err = deg(sol.cost); }
    }
    out[id] = { elevDeg: best, ankleHeightM: best > -90 ? hipH + L * Math.sin(best * DEG) : NaN, errAtTopDeg: err };
  }
  return out;
}

export function pivotFits(v: Variant) {
  const rng = hipRangesOf(v, side);
  const rows = [];
  for (const flex of [30, 50]) for (const psi of [90, 180]) {
    const sol = solveHip(v.layout, side, rng, rotCost(pivotTarget(psi, flex)));
    const st = jointUse(sol.q);
    rows.push({ flexDeg: flex, turnDeg: psi, errDeg: deg(sol.cost), angles: angles(sol.q), jointsUsed: st });
  }
  // How close the pivot path runs to a gimbal lock: σmin of the hip's angular Jacobian along 0→180°.
  let prev: HipAngles | undefined;
  let minSigma = Infinity;
  for (let psi = 0; psi <= 180; psi += 5) {
    const sol = solveHipNear(v.layout, rng, rotCost(pivotTarget(psi, 30)), prev);
    prev = sol.q;
    minSigma = Math.min(minSigma, sigmaMin(v.layout, sol.q));
  }
  return { rows, pathSigmaMin: minSigma };
}

const jointUse = (q: HipAngles) => (['p', 'r', 'y'] as const).filter((k) => Math.abs(q[k]) > 10 * DEG).map((k) => ({ p: 'pitch', r: 'roll', y: 'yaw' })[k]).join('+') || 'none';

/** Local refine from a start (continuity along a path); global solve when there is none. */
export function solveHipNear(layout: Layout, rng: ReturnType<typeof hipRangesOf>, cost: ReturnType<typeof rotCost>, start?: HipAngles) {
  if (!start) return solveHip(layout, side, rng, cost);
  const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));
  let q = { ...start }, c = cost(fkHip(layout, side, q), q), step = 4 * DEG;
  while (step > 0.01 * DEG) {
    let improved = false;
    for (const key of ['p', 'r', 'y'] as const) for (const sgn of [1, -1]) {
      const n = { ...q, [key]: clamp(q[key] + sgn * step, rng[key]) };
      const nc = cost(fkHip(layout, side, n), n);
      if (nc < c - 1e-12) { q = n; c = nc; improved = true; }
    }
    if (!improved) step /= 2;
  }
  return { q, cost: c };
}

/**
 * Smallest singular value of the hip's angular Jacobian (columns: the three joint axes in the pelvis
 * frame). 1 = three orthogonal axes; 0 = gimbal lock (two axes line up).
 */
export function sigmaMin(layout: Layout, q: HipAngles): number {
  let cols: V3[];
  if (layout === 'stock') {
    const Rz = rz(q.y), Rzx = mul(rz(q.y), rx(q.r));
    cols = [[0, 0, 1], apply(Rz, [1, 0, 0]), apply(Rzx, [0, 1, 0])];
  } else {
    const a = pitchAxis(side);
    const Ra = rAxis(a, q.p), Rar = mul(Ra, rx(q.r));
    cols = [a, apply(Ra, [1, 0, 0]), apply(Rar, [0, 0, 1])];
  }
  // JᵀJ eigenvalues (3×3 symmetric) by Jacobi rotations.
  const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => dot(cols[i], cols[j])));
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [p, r] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(A[p][r]) < 1e-15) continue;
      const th = 0.5 * Math.atan2(2 * A[p][r], A[r][r] - A[p][p]);
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akr = A[k][r]; A[k][p] = c * akp - s * akr; A[k][r] = s * akp + c * akr; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], ark = A[r][k]; A[p][k] = c * apk - s * ark; A[r][k] = s * apk + c * ark; }
    }
  }
  return Math.sqrt(Math.max(0, Math.min(A[0][0], A[1][1], A[2][2])));
}

/** σmin along a straight joint-space path from the stance hip to a kick solution. */
export function kickPathSigma(v: Variant, to: HipAngles): number {
  const st = { p: v.design.stance.hip_pitch_l, r: v.design.stance.hip_roll_l, y: v.design.stance.hip_yaw_l };
  let m = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) m = Math.min(m, sigmaMin(v.layout, { p: st.p + t * (to.p - st.p), r: st.r + t * (to.r - st.r), y: st.y + t * (to.y - st.y) }));
  return m;
}

