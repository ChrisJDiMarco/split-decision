// Phase 0 crouched pivot in physics: the left foot is welded where it sits at qpos0 (~8 mm above the
// canvas, so the weld carries the weight and every tipping moment; CopProbe logs where a real sole
// would have had to push), the right leg is tucked, and the pelvis turns 0 → 180° over
// the planted foot in 1.5 s (min-jerk) from a fighting crouch (thigh flexed 30° or 50° in the foot's
// plane). The hip follows the IK path for this variant's layout and ranges, continuous in ψ.
// Logged: the turn achieved, orientation error, which hip joints moved and how far, peak torque,
// speed and heat against the drive ratings.
import { fkHip, rotCost, solveHip, type HipAngles } from './hipik';
import { solveHipNear } from './kinematics';
import { DEG, mul, rotAngle, rz, tr, xmatAt, v3At, apply, sub, type M3, type V3 } from './math3';
import { footHalf, Kin, liveSole } from './kin';
import { ComBalance, liveComOffset } from './balance';

import { rangeOf } from './tests-kick';
import { minimize, minJerk } from './opt';
import { pivotTarget } from './poses';
import { makeVSim, placeJoints, Recorder, bodyId, type VSim } from './sim';
import { hipRangesOf, type Variant } from './variants';

const deg = (x: number) => x / DEG;

/**
 * Honesty probe for the weld (added by the Phase 0 verifier). The weld holds the foot where it sits at
 * qpos0, which is ~8 mm ABOVE the canvas, so it carries the robot's whole weight and every tipping
 * moment; a real sole cannot pull down or push outside its own outline. This measures the total ground
 * wrench the robot needs (Σ cfrc_ext + the free joint's cfrc_int = Σ I·a + v×Iv, gravity included, so
 * it does not matter whether the weld or the contacts deliver it) and where its centre of pressure
 * lands in the welded foot's frame. A CoP outside the sole box means a real foot would roll there.
 */
class CopProbe {
  private readonly bodies: number[] = [];
  worstOutsideM = 0; outsideS = 0; minNormalN = Infinity;
  constructor(private readonly sim: VSim) {
    const m = sim.ctx.model;
    for (let b = 1; b < m.nbody; b++) if (m.body_rootid[b] === sim.r.rootBody) this.bodies.push(b);
  }
  sample() {
    const { model, data } = this.sim.ctx;
    this.sim.mj.mj_rnePostConstraint(model, data);
    const root = this.sim.r.rootBody;
    const W = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k++) W[k] += data.cfrc_int[root * 6 + k];
    for (const b of this.bodies) for (let k = 0; k < 6; k++) W[k] += data.cfrc_ext[b * 6 + k];
    const c = v3At(data.subtree_com, root);
    const { sole, F } = liveSole(this.sim, 'l');
    this.minNormalN = Math.min(this.minNormalN, W[5]);
    const rz = c[2] - sole[2];
    const px = c[0] - (W[1] + rz * W[3]) / W[5], py = c[1] - (rz * W[4] - W[0]) / W[5];
    const dx = px - sole[0], dy = py - sole[1];
    const lx = F[0] * dx + F[3] * dy, ly = F[1] * dx + F[4] * dy;
    const [hx, hy] = footHalf(this.sim, 'l');
    const out = W[5] <= 0 ? Infinity : Math.max(Math.abs(lx) - hx, Math.abs(ly) - hy, 0);
    this.worstOutsideM = Math.max(this.worstOutsideM, out);
    if (out > 0) this.outsideS += this.sim.ctx.dt;
  }
}

/** Rotation matrix → quaternion (w, x, y, z). */
function quatOf(m: M3): [number, number, number, number] {
  const t = m[0] + m[4] + m[8];
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; return [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s]; }
  if (m[0] > m[4] && m[0] > m[8]) { const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; return [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s]; }
  if (m[4] > m[8]) { const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; return [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s]; }
  const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s];
}

/** Move the free root so `foot` sits at the pose (R0, p0) with the current joint angles. */
export function placeRootForFoot(sim: VSim, foot: string, R0: M3, p0: V3) {
  const { model, data } = sim.ctx;
  const a = sim.r.rootQadr;
  data.qpos[a] = 0; data.qpos[a + 1] = 0; data.qpos[a + 2] = 0;
  data.qpos[a + 3] = 1; data.qpos[a + 4] = 0; data.qpos[a + 5] = 0; data.qpos[a + 6] = 0;
  sim.mj.mj_kinematics(model, data);
  const b = bodyId(sim, foot);
  const Fp = xmatAt(data.xmat, b), fpos = v3At(data.xpos, b);
  const Rroot = mul(R0, tr(Fp));
  const pos = sub(p0, apply(Rroot, fpos));
  const q = quatOf(Rroot);
  data.qpos[a] = pos[0]; data.qpos[a + 1] = pos[1]; data.qpos[a + 2] = pos[2];
  for (let i = 0; i < 4; i++) data.qpos[a + 3 + i] = q[i];
  for (let i = 0; i < 6; i++) data.qvel[sim.r.rootDadr + i] = 0;
  sim.mj.mj_forward(model, data);
}

const PIVOT_VARS = ['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l', 'ankle_pitch_l', 'ankle_roll_l', 'waist_pitch'];

/**
 * Whole-body pivot plan at turn ψ: the left leg and waist pitch put the pelvis level and turned ψ over
 * the planted left sole with the COM over it. Warm-started from the previous ψ so the path is continuous.
 */
function planPivotPose(sim: VSim, kin: Kin, base: Record<string, number>, psiDeg: number, seed: number) {
  const target = rz(-psiDeg * DEG);
  const box = { lo: PIVOT_VARS.map((n) => rangeOf(sim, n)[0] + 0.005), hi: PIVOT_VARS.map((n) => rangeOf(sim, n)[1] - 0.005) };
  const f = (x: number[]) => {
    const q = { ...base };
    PIVOT_VARS.forEach((n, i) => { q[n] = x[i]; });
    const e = kin.eval(q);
    const dev = PIVOT_VARS.reduce((s, n, i) => s + (x[i] - base[n]) ** 2, 0);
    return (e.com[0] ** 2 + e.com[1] ** 2) / 0.004 ** 2 + (rotAngle(e.pelvisR, target) / DEG) ** 2 + 0.5 * dev;
  };
  const sol = minimize(f, PIVOT_VARS.map((n) => base[n]), PIVOT_VARS.map(() => 0.05), box, { iters: 20, pop: 32, elite: 6, seed });
  const q = { ...base };
  PIVOT_VARS.forEach((n, i) => { q[n] = sol.x[i]; });
  const e = kin.eval(q);
  return { q, com: e.com, errDeg: rotAngle(e.pelvisR, target) / DEG };
}

export async function pivot(v: Variant, durationS = 1.5) {
  const rows = [];
  const rng = hipRangesOf(v, 'l');
  for (const flex of [30, 50]) {
    // Hip-only IK path (pelvis level, no balance): the pure layout question.
    let prev: HipAngles | undefined;
    const ikErr: number[] = [];
    const ikPath: HipAngles[] = [];
    for (let psi = 0; psi <= 180; psi += 5) {
      const sol = solveHipNear(v.layout, rng, rotCost(pivotTarget(psi, flex)), prev ?? solveHip(v.layout, 'l', rng, rotCost(pivotTarget(psi, flex))).q);
      prev = sol.q;
      ikPath.push(sol.q);
      ikErr.push(sol.cost);
    }
    const th = flex * DEG;
    const tuck = solveHip(v.layout, 'r', hipRangesOf(v, 'r'), rotCost(fkHip('stock', 'r', { p: -(th + 55 * DEG), r: -0.1, y: 0 })), 4).q;
    const legR = { hip_pitch_r: tuck.p, hip_roll_r: tuck.r, hip_yaw_r: tuck.y, knee_r: Math.min(2 * th + 70 * DEG, 2.3), ankle_pitch_r: 0, ankle_roll_r: 0 };

    const sim = await makeVSim(v, { footWeld: 'l' });
    sim.release();
    const kin = new Kin(sim, 'l');
    // Whole-body plan every 10°, warm-started along ψ.
    const h0 = ikPath[0];
    let base: Record<string, number> = { ...sim.r.design.stance, ...legR, hip_pitch_l: h0.p, hip_roll_l: h0.r, hip_yaw_l: h0.y, knee_l: 2 * th, ankle_pitch_l: -th, ankle_roll_l: 0 };
    const keys: Array<{ psi: number; q: Record<string, number>; com: V3; errDeg: number }> = [];
    for (let psi = 0; psi <= 180; psi += 10) {
      const h = ikPath[psi / 5];
      const p = planPivotPose(sim, kin, { ...base, hip_pitch_l: h.p, hip_roll_l: h.r, hip_yaw_l: h.y }, psi, 3 + psi);
      keys.push({ psi, ...p });
      base = p.q;
    }
    const bal = new ComBalance(sim, kin, 'l', ['ankle_pitch_l', 'ankle_roll_l', 'hip_pitch_l', 'hip_roll_l'], [1, 1, 3, 3]);
    const jac = keys.map((k) => bal.jacobian(k.q));
    const at = (psi: number) => {
      const x = Math.min(keys.length - 1.000001, Math.max(0, psi / 10));
      const i = Math.floor(x), f = x - i;
      const q: Record<string, number> = {};
      for (const n of Object.keys(keys[i].q)) q[n] = keys[i].q[n] + f * (keys[i + 1].q[n] - keys[i].q[n]);
      const com = keys[i].com.map((c, j) => c + f * (keys[i + 1].com[j] - c)) as V3;
      return { q, com, J: jac[Math.round(x)] };
    };
    // Where the weld holds the foot: its pose at qpos0 (legs straight, root at the spawn).
    const { model, data } = sim.ctx;
    for (let i = 0; i < model.nq; i++) data.qpos[i] = model.qpos0[i];
    sim.mj.mj_kinematics(model, data);
    const fb = bodyId(sim, 'foot_l');
    const F0 = xmatAt(data.xmat, fb), p0 = v3At(data.xpos, fb);
    placeJoints(sim, at(0).q);
    placeRootForFoot(sim, 'foot_l', F0, p0);
    for (let i = 0; i < 500; i++) { if (i % 2 === 0) { const a = at(0); bal.tick(a.q, a.com, a.J, 1, 2 * sim.ctx.dt); } sim.step(); }
    const rec = new Recorder(sim);
    const cop = new CopProbe(sim);
    const n = Math.round((durationS + 0.5) / sim.ctx.dt);
    const use = { p: [Infinity, -Infinity], r: [Infinity, -Infinity], y: [Infinity, -Infinity] };
    let maxCom = 0;
    for (let i = 0; i < n; i++) {
      const t = i * sim.ctx.dt;
      const psi = 180 * minJerk(t / durationS);
      if (i % 2 === 0) { const a = at(psi); bal.tick(a.q, a.com, a.J, 1, 2 * sim.ctx.dt); }
      sim.step();
      rec.sample();
      cop.sample();
      const c = liveComOffset(sim, 'l');
      maxCom = Math.max(maxCom, Math.hypot(c[0], c[1]));
      for (const k of ['p', 'r', 'y'] as const) {
        const q = sim.ctx.data.qpos[sim.r.joints[sim.r.jointIndex.get(`hip_${{ p: 'pitch', r: 'roll', y: 'yaw' }[k]}_l`)!].qadr];
        use[k][0] = Math.min(use[k][0], q); use[k][1] = Math.max(use[k][1], q);
      }
    }
    const F = xmatAt(data.xmat, fb), P = xmatAt(data.xmat, bodyId(sim, 'pelvis'));
    const rel = mul(tr(F), P); // pelvis in the foot frame; ideal Rz(−180°)
    const turned = -Math.atan2(rel[3], rel[0]);
    const s = rec.summary(['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l', 'ankle_pitch_l', 'ankle_roll_l']);
    rows.push({
      flexDeg: flex,
      durationS,
      hipIkEndErrDeg: deg(ikErr[ikErr.length - 1]),
      planEndErrDeg: keys[keys.length - 1].errDeg,
      turnDeg: ((deg(turned) % 360) + 360) % 360,
      finalErrDeg: deg(rotAngle(rel, rz(-Math.PI))),
      maxComOffsetM: maxCom,
      hipTravelDeg: { pitch: deg(use.p[1] - use.p[0]), roll: deg(use.r[1] - use.r[0]), yaw: deg(use.y[1] - use.y[0]) },
      peakTauFrac: s.peakTauFrac, worstJoint: s.worstJoint, peakSpeedFrac: s.peakSpeedFrac, peakTempC: s.peakTempC, maxSatS: s.maxSatS,
      perJoint: Object.fromEntries(['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l', 'ankle_pitch_l', 'ankle_roll_l'].map((j) => [j, +rec.peaks.get(j)!.tauFrac.toFixed(3)])),
      derated: [...rec.derated],
      // Weld honesty (see CopProbe): how long and how far the needed CoP leaves the sole.
      copOutsideSoleS: cop.outsideS,
      worstCopOutsideSoleM: cop.worstOutsideM,
      minNormalN: cop.minNormalN,
    });
    kin.dispose();
    sim.dispose();
  }
  return rows;
}
