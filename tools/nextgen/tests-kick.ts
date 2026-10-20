// Phase 0 kick tests in physics (motor model on, no gyro, no production controller):
//  · gantry: pelvis held by the gantry weld, the left leg steps from stance to each kick pose's best
//    IK fit; final pose error, time to 90% of the move, peak torque, speed and heat.
//  · hold: free on the canvas, the same COM-balance law for every variant shifts onto the right foot,
//    raises the left leg to the kick pose and holds it 1 s; 5 seeds. Falls, COM margin to the sole's
//    edge, torso lean, kick pose error (hip-relative and world), hip torque vs stall, ankle stops.
import { anyContact } from '../../src/physics/control/contacts';
import { fkHip, kickCost, rotCost, solveHip, thighDir, kneeAxis, type HipAngles } from './hipik';
import { DEG, angle, apply, mul, rotAngle, tr, xmatAt, type M3, type V3 } from './math3';
import { footHalf, Kin, liveSole } from './kin';
import { gauss, minimize, minJerk, mulberry32 } from './opt';
import { ComBalance, liveComOffset } from './balance';
import { KICKS, type KickPose } from './poses';
import { makeVSim, Recorder, setTargets, bodyId, type VSim } from './sim';
import { hipRangesOf, type Variant } from './variants';

const deg = (x: number) => x / DEG;
const LEFT_LEG = ['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l', 'knee_l'];

export function kickSolution(v: Variant, k: KickPose): HipAngles {
  return solveHip(v.layout, 'l', hipRangesOf(v, 'l'), kickCost(k.d, k.k)).q;
}

function thighRel(sim: VSim, side: 'l' | 'r'): M3 {
  const P = xmatAt(sim.ctx.data.xmat, bodyId(sim, 'pelvis'));
  const T = xmatAt(sim.ctx.data.xmat, bodyId(sim, `thigh_${side}`));
  return mul(tr(P), T);
}

// ---------------------------------------------------------------- gantry reach

export async function gantry(v: Variant) {
  const rows = [];
  for (const k of KICKS) {
    const q = kickSolution(v, k);
    const sim = await makeVSim(v, { lift: 0.45 });
    sim.run(0.5);
    const cmd = fkHip(v.layout, 'l', q);
    const rec = new Recorder(sim);
    setTargets(sim.r, { hip_pitch_l: q.p, hip_roll_l: q.r, hip_yaw_l: q.y, knee_l: k.knee, ankle_pitch_l: 0, ankle_roll_l: 0 });
    const d0 = angle(thighDir(thighRel(sim, 'l')), thighDir(cmd));
    let t90 = NaN;
    const T = 1.5;
    const n = Math.round(T / sim.ctx.dt);
    for (let i = 0; i < n; i++) {
      sim.step();
      rec.sample();
      if (Number.isNaN(t90) && angle(thighDir(thighRel(sim, 'l')), thighDir(cmd)) <= 0.1 * d0) t90 = (i + 1) * sim.ctx.dt;
    }
    const R = thighRel(sim, 'l');
    const poseErr = angle(thighDir(R), k.d) + angle(kneeAxis(R), k.k);
    const trackErr = angle(thighDir(R), thighDir(cmd)) + angle(kneeAxis(R), kneeAxis(cmd));
    const s = rec.summary(LEFT_LEG);
    rows.push({
      kick: k.id,
      ikErrDeg: deg(kickCost(k.d, k.k)(cmd, q)),
      finalPoseErrDeg: deg(poseErr),
      trackErrDeg: deg(trackErr),
      moveDeg: deg(d0),
      t90S: t90,
      peakTauFrac: s.peakTauFrac, worstJoint: s.worstJoint, peakSpeedFrac: s.peakSpeedFrac, peakTempC: s.peakTempC, maxSatS: s.maxSatS,
      derated: [...rec.derated],
      perJoint: Object.fromEntries(LEFT_LEG.map((j) => [j, { tauFrac: +rec.peaks.get(j)!.tauFrac.toFixed(3), speedFrac: +rec.peaks.get(j)!.speedFrac.toFixed(3) }])),
    });
    sim.dispose();
  }
  return rows;
}

// ---------------------------------------------------------------- one-leg hold

const LEGS = ['hip_pitch', 'hip_roll', 'hip_yaw', 'knee', 'ankle_pitch', 'ankle_roll'];
/** Support-leg joints the single-support planner moves (right leg + waist pitch). */
const SUPPORT = ['hip_pitch_r', 'hip_roll_r', 'hip_yaw_r', 'knee_r', 'ankle_pitch_r', 'ankle_roll_r', 'waist_pitch'];
/** Joints the balance law corrects with, in order of preference (ankle strategy, then hip). */
const BAL = ['ankle_pitch_r', 'ankle_roll_r', 'hip_pitch_r', 'hip_roll_r'];
const BAL_WEIGHT = [1, 1, 2.5, 2.5];

export function rangeOf(sim: VSim, name: string): [number, number] {
  const j = sim.r.joints[sim.r.jointIndex.get(name)!];
  const jid = sim.ctx.model.actuator_trnid[j.act * 2];
  return [sim.ctx.model.jnt_range[jid * 2], sim.ctx.model.jnt_range[jid * 2 + 1]];
}

const leanOf = (e: { torsoUp: number[] }) => Math.acos(Math.max(-1, Math.min(1, e.torsoUp[2])));

/** Double support: both legs move, the left foot stays where it is, the COM goes over the right sole. */
function planShift(sim: VSim, kin: Kin, base: Record<string, number>, seed: number) {
  const names = [...LEGS.flatMap((j) => [`${j}_l`, `${j}_r`]), 'waist_pitch'];
  const ref = kin.eval(base);
  const box = { lo: names.map((n) => rangeOf(sim, n)[0] + 0.01), hi: names.map((n) => rangeOf(sim, n)[1] - 0.01) };
  const f = (x: number[]) => {
    const q = { ...base };
    names.forEach((n, i) => { q[n] = x[i]; });
    const e = kin.eval(q);
    const dp = e.kickAnkle.map((v, i) => v - ref.kickAnkle[i]);
    const dR = rotAngle(e.kickFootR, ref.kickFootR);
    const dev = names.reduce((s, n, i) => s + (x[i] - base[n]) ** 2, 0);
    return (e.com[0] ** 2 + e.com[1] ** 2) / 0.004 ** 2 + (dp[0] ** 2 + dp[1] ** 2 + dp[2] ** 2) / 0.002 ** 2 + (dR / 0.01) ** 2 + 4 * leanOf(e) ** 2 + 0.05 * dev;
  };
  const sol = minimize(f, names.map((n) => base[n]), names.map(() => 0.08), box, { iters: 40, pop: 48, elite: 8, seed });
  const q = { ...base };
  names.forEach((n, i) => { q[n] = sol.x[i]; });
  return q;
}

/** Single support: plan the right leg + waist pitch so the COM is over the right sole with the left leg at `leg`. */
function planSupport(sim: VSim, kin: Kin, base: Record<string, number>, leg: Record<string, number>, seed: number) {
  const box = { lo: SUPPORT.map((n) => rangeOf(sim, n)[0] + 0.01), hi: SUPPORT.map((n) => rangeOf(sim, n)[1] - 0.01) };
  const f = (x: number[]) => {
    const q = { ...base, ...leg };
    SUPPORT.forEach((n, i) => { q[n] = x[i]; });
    const e = kin.eval(q);
    const clear = Math.max(0, 0.16 - e.kickAnkle[2]);
    const dev = SUPPORT.reduce((s, n, i) => s + (x[i] - base[n]) ** 2, 0);
    return (e.com[0] ** 2 + e.com[1] ** 2) / 0.004 ** 2 + 4 * leanOf(e) ** 2 + 0.3 * (x[3] - 0.35) ** 2 + (clear / 0.01) ** 2 + 0.2 * dev;
  };
  const sol = minimize(f, SUPPORT.map((n) => base[n]), SUPPORT.map(() => 0.15), box, { iters: 25, pop: 32, elite: 6, seed });
  const q = { ...base, ...leg };
  SUPPORT.forEach((n, i) => { q[n] = sol.x[i]; });
  return q;
}

export interface HoldResult {
  kick: string; seed: number; ok: boolean; why: string; failAtS: number;
  minMarginM: number; maxLeanDeg: number; poseErrDeg: number; worldErrDeg: number; kickAnkleZ: number;
  plannedWorldErrDeg: number; plannedLeanDeg: number;
  hipTauFrac: number; hipWorst: string; kickHipTauFrac: Record<string, number>; supportTauFrac: number; supportPeaks: Record<string, { tau: number; satS: number }>; ankleStopS: number; derated: string[]; planComErrMm: number;
}

/**
 * The held pose: support leg + waist pitch AND the kicking hip, so the kick is right in the WORLD (the
 * support foot's heading), not just relative to the pelvis. Leaning the torso is allowed, because real
 * fighters lean away from a side kick, but it costs: 30° of lean weighs the same as 3° of kick error,
 * so the lean the planner ends up using is the "torso-lean fake" the stock hip needs.
 */
function planFinal(sim: VSim, kin: Kin, base: Record<string, number>, k: KickPose, kneeAngle: number, seed: number) {
  const names = [...SUPPORT, 'hip_pitch_l', 'hip_roll_l', 'hip_yaw_l'];
  const box = { lo: names.map((n) => rangeOf(sim, n)[0] + 0.005), hi: names.map((n) => rangeOf(sim, n)[1] - 0.005) };
  const leg = { knee_l: kneeAngle, ankle_pitch_l: 0, ankle_roll_l: 0 };
  const f = (x: number[]) => {
    const q: Record<string, number> = { ...base, ...leg };
    names.forEach((n, i) => { q[n] = x[i]; });
    const e = kin.eval(q);
    const Tw = mul(e.pelvisR, e.thighRel);
    const err = angle(thighDir(Tw), k.d) + angle(kneeAxis(Tw), k.k);
    const clear = Math.max(0, 0.16 - e.kickAnkle[2]);
    return (e.com[0] ** 2 + e.com[1] ** 2) / 0.004 ** 2 + (err / (3 * DEG)) ** 2 + (leanOf(e) / (30 * DEG)) ** 2 + 0.3 * (x[3] - 0.35) ** 2 + (clear / 0.01) ** 2;
  };
  let best: { x: number[]; f: number } | null = null;
  // Two starts: the hip-relative IK fit with the stance support, and the warm start.
  for (const [i, start] of [names.map((n) => base[n]), names.map((n) => (n.endsWith('_l') ? base[n] : base[n]))].entries()) {
    const sol = minimize(f, start, names.map(() => 0.2), box, { iters: 40, pop: 48, elite: 8, seed: seed + i });
    if (!best || sol.f < best.f) best = sol;
  }
  const q: Record<string, number> = { ...base, ...leg };
  names.forEach((n, i) => { q[n] = best!.x[i]; });
  return q;
}

/** Waypoints of a hold, planned once per variant and kick (independent of the seed). */
export function planHold(sim: VSim, v: Variant, k: KickPose) {
  const kin = new Kin(sim, 'r');
  const stance: Record<string, number> = { ...sim.r.design.stance };
  const kq = kickSolution(v, k);
  // Lifted leg for the step off: thigh flexed ~35°, knee 70°, solved through this hip.
  const lq = solveHip(v.layout, 'l', hipRangesOf(v, 'l'), rotCost(fkHip('stock', 'l', { p: -0.6, r: 0.06, y: 0 })), 4).q;
  const lifted = { hip_pitch_l: lq.p, hip_roll_l: lq.r, hip_yaw_l: lq.y, knee_l: 1.2, ankle_pitch_l: -0.4, ankle_roll_l: 0 };
  const shift = planShift(sim, kin, stance, 5);
  const up = planSupport(sim, kin, shift, lifted, 7);
  // The final pose starts from the hip-relative IK fit.
  const final = planFinal(sim, kin, { ...up, hip_pitch_l: kq.p, hip_roll_l: kq.r, hip_yaw_l: kq.y }, k, k.knee, 13);
  const kick: Record<string, number> = { hip_pitch_l: final.hip_pitch_l, hip_roll_l: final.hip_roll_l, hip_yaw_l: final.hip_yaw_l, knee_l: k.knee, ankle_pitch_l: 0, ankle_roll_l: 0 };
  const keys: Array<Record<string, number>> = [stance, shift, up];
  // In between, every joint moves on a straight line from `up` to `final`, and the support leg is
  // re-planned at each waypoint (staying close to that line) so the COM stays over the sole.
  for (const a of [0.2, 0.4, 0.6, 0.8]) {
    const base: Record<string, number> = {};
    for (const n of Object.keys(final)) base[n] = up[n] + a * (final[n] - up[n]);
    const leg: Record<string, number> = {};
    for (const n of Object.keys(kick)) leg[n] = base[n];
    keys.push(planSupport(sim, kin, base, leg, 11));
  }
  keys.push(final);
  const coms = keys.map((q) => kin.eval(q).com);
  const bal = new ComBalance(sim, kin, 'r', BAL, BAL_WEIGHT);
  const jac = keys.map((q) => bal.jacobian(q));
  const fe = kin.eval(final);
  const Tw = mul(fe.pelvisR, fe.thighRel);
  const planned = { worldErrDeg: (angle(thighDir(Tw), k.d) + angle(kneeAxis(Tw), k.k)) / DEG, leanDeg: leanOf(fe) / DEG, hipRelErrDeg: (angle(thighDir(fe.thighRel), k.d) + angle(kneeAxis(fe.thighRel), k.k)) / DEG };
  return { kin, keys, coms, jac, bal, kick, planned };
}

const planCache = new Map<string, { keys: Array<Record<string, number>>; coms: number[][]; jac: number[][][]; planned: { worldErrDeg: number; leanDeg: number; hipRelErrDeg: number } }>();

export async function hold(v: Variant, k: KickPose, seed: number): Promise<HoldResult> {
  const rng = mulberry32(1000 + seed);
  const sim = await makeVSim(v, { seed });
  sim.run(0.3);
  sim.release();
  sim.run(1.0);
  const key = `${v.id}/${k.id}`;
  if (!planCache.has(key)) {
    const p = planHold(sim, v, k);
    planCache.set(key, { keys: p.keys, coms: p.coms, jac: p.jac, planned: p.planned });
    p.kin.dispose();
  }
  const { keys, coms, jac, planned } = planCache.get(key)!;
  const kin = new Kin(sim, 'r');
  const bal = new ComBalance(sim, kin, 'r', BAL, BAL_WEIGHT);
  // Seeded jitter: ±10% phase times, ±0.5° target noise.
  const jit = () => 1 + 0.1 * (rng() * 2 - 1);
  // Phases: shift (double support, both ankles balance) → wait on both feet until the COM has
  // settled over the right sole (≤ 1.5 cm, ≤ 5 cm/s; 1.5 s at most) → lift (the single-support law
  // fades in) → raise the kick → settle → hold 1 s.
  const T_SHIFT = 1.3 * jit(), T_WAIT_MIN = 0.3, T_WAIT_MAX = 1.5, T_LIFT = 0.5 * jit(), T_KICK = 1.2 * jit();
  const SETTLE = 0.3, HOLD = 1.0;
  const names = Object.keys(keys[keys.length - 1]);
  const noise: Record<string, number> = {};
  for (const n of names) noise[n] = 0.5 * DEG * gauss(rng);
  const lerp = (u: number) => {
    const i = Math.min(keys.length - 2, Math.floor(u)), f = u - i;
    const q: Record<string, number> = {};
    for (const n of names) q[n] = (keys[i][n] ?? 0) + f * ((keys[i + 1][n] ?? 0) - (keys[i][n] ?? 0)) + noise[n];
    const c = coms[i].map((x, j) => x + f * (coms[i + 1][j] - x)) as V3;
    return { q, com: c, J: jac[Math.min(keys.length - 1, Math.round(u))] };
  };
  const DS = { joints: ['ankle_pitch_r', 'ankle_roll_r'], mirror: { ankle_pitch_r: 'ankle_pitch_l', ankle_roll_r: 'ankle_roll_l' } };
  const rec = new Recorder(sim);
  const [hx, hy] = footHalf(sim, 'r');
  const torso = bodyId(sim, 'torso');
  const pelvisZ0 = sim.ctx.data.xpos[bodyId(sim, 'pelvis') * 3 + 2];
  const geomsAllowed = new Set(sim.r.parts.get('foot_r')!.geoms);
  const robotGeoms = new Set([...sim.r.parts.values()].flatMap((p) => p.geoms));
  let minMargin = Infinity, maxLean = 0, fell = false, why = '', failAt = NaN, poseErr = 0, worldErr = 0, ankleZ = 0, nHold = 0, ankleStop = 0;
  type Phase = 'shift' | 'wait' | 'lift' | 'kick' | 'settle' | 'hold' | 'done';
  let phase = 'shift' as Phase;
  let t0 = 0; // phase start
  let prevC: V3 | null = null;
  const dt = sim.ctx.dt;
  const maxSteps = Math.round((T_SHIFT + T_WAIT_MAX + T_LIFT + T_KICK + SETTLE + HOLD + 0.1) / dt);
  for (let i = 0; i < maxSteps && !fell && phase !== 'done'; i++) {
    const t = i * dt;
    const pt = t - t0;
    const next = (p: Phase) => { phase = p; t0 = t; };
    let u = 0, gain = 0, ds = false;
    if (phase === 'shift') { u = minJerk(pt / T_SHIFT); ds = true; gain = 1; if (pt >= T_SHIFT) next('wait'); }
    else if (phase === 'wait') {
      u = 1; ds = true; gain = 1;
      if (i % 2 === 0) {
        const c = liveComOffset(sim, 'r');
        const v = prevC ? Math.hypot(c[0] - prevC[0], c[1] - prevC[1]) / (2 * dt) : 1;
        prevC = c;
        if ((pt >= T_WAIT_MIN && Math.hypot(c[0] - coms[1][0], c[1] - coms[1][1]) < 0.015 && v < 0.05) || pt >= T_WAIT_MAX) next('lift');
      }
    }
    else if (phase === 'lift') { u = 1 + minJerk(pt / T_LIFT); gain = minJerk(pt / T_LIFT); if (pt >= T_LIFT) next('kick'); }
    else if (phase === 'kick') { u = 2 + (keys.length - 3) * minJerk(pt / T_KICK); gain = 1; if (pt >= T_KICK) next('settle'); }
    else if (phase === 'settle') { u = keys.length - 1; gain = 1; if (pt >= SETTLE) next('hold'); }
    else { u = keys.length - 1; gain = 1; if (pt >= HOLD) next('done'); }
    if (i % 2 === 0) {
      const p = lerp(u);
      if (ds) bal.tick(p.q, p.com, jac[1], gain, 2 * dt, { ...DS, integrate: false });
      else bal.tick(p.q, p.com, p.J, gain, 2 * dt);
    }
    sim.step();
    rec.sample();
    const up = sim.ctx.data.xmat[torso * 9 + 8];
    if (process.env.NG_DEBUG && i % 100 === 0) {
      const c = liveComOffset(sim, 'r');
      console.log(`t ${t.toFixed(2)} ${phase} com ${c.map((x) => x.toFixed(3))} plan ${lerp(u).com.map((x) => x.toFixed(3))} pelvis z ${sim.ctx.data.xpos[bodyId(sim, 'pelvis') * 3 + 2].toFixed(3)} up ${up.toFixed(3)} Fz ${liveSole(sim, 'r').F[8].toFixed(3)}`);
    }
    // Single-support checks start once the lift is done (a lifting foot may still brush the canvas).
    const single = phase === 'kick' || phase === 'settle' || phase === 'hold';
    if (up < 0.5) { fell = true; why = 'torso past 60°'; }
    // Tipping: the support foot rolls more than 20° off flat once the other foot is up.
    if (single && i % 5 === 0 && liveSole(sim, 'r').F[8] < Math.cos(20 * DEG)) { fell = true; why = 'support foot rolled over'; }
    if (sim.ctx.data.xpos[bodyId(sim, 'pelvis') * 3 + 2] < 0.6 * pelvisZ0) { fell = true; why = 'pelvis dropped'; }
    if (single && i % 10 === 0 && anyContact(sim.ctx.data, (g1, g2) => (g1 === 0 && robotGeoms.has(g2) && !geomsAllowed.has(g2)) || (g2 === 0 && robotGeoms.has(g1) && !geomsAllowed.has(g1)))) { fell = true; why = 'touched down off the support foot'; }
    if (fell) { failAt = t; why = `${why} (${phase})`; }
    if (phase === 'hold') {
      nHold++;
      const c = liveComOffset(sim, 'r');
      minMargin = Math.min(minMargin, Math.min(hx - Math.abs(c[0]), hy - Math.abs(c[1])));
      maxLean = Math.max(maxLean, Math.acos(Math.max(-1, Math.min(1, up))));
      const R = thighRel(sim, 'l');
      poseErr += angle(thighDir(R), k.d) + angle(kneeAxis(R), k.k);
      // World frame: the targets in the support foot's heading.
      const F = liveSole(sim, 'r').F;
      const yaw = Math.atan2(F[3], F[0]);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const Hd = [cy, -sy, 0, sy, cy, 0, 0, 0, 1];
      const Rw = xmatAt(sim.ctx.data.xmat, bodyId(sim, 'thigh_l'));
      worldErr += angle(thighDir(Rw), apply(Hd, k.d)) + angle(kneeAxis(Rw), apply(Hd, k.k));
      ankleZ += sim.ctx.data.xpos[bodyId(sim, 'foot_l') * 3 + 2];
      const ap = sim.ctx.data.qpos[sim.r.joints[sim.r.jointIndex.get('ankle_pitch_r')!].qadr], ar = sim.ctx.data.qpos[sim.r.joints[sim.r.jointIndex.get('ankle_roll_r')!].qadr];
      const [plo, phi] = rangeOf(sim, 'ankle_pitch_r'), [rlo, rhi] = rangeOf(sim, 'ankle_roll_r');
      if (ap - plo < DEG || phi - ap < DEG || ar - rlo < DEG || rhi - ar < DEG) ankleStop += dt;
    }
  }
  const hips = rec.summary(['hip_']);
  const sup = rec.summary(['hip_pitch_r', 'hip_roll_r', 'hip_yaw_r', 'knee_r', 'ankle_pitch_r', 'ankle_roll_r']);
  const last = coms[coms.length - 1];
  const out: HoldResult = {
    kick: k.id, seed, ok: !fell && nHold > 0 && rec.derated.size === 0, why: fell ? why : rec.derated.size ? `thermal derate: ${[...rec.derated].join(',')}` : '', failAtS: failAt,
    minMarginM: nHold ? minMargin : NaN, maxLeanDeg: deg(maxLean), poseErrDeg: nHold ? deg(poseErr / nHold) : NaN, worldErrDeg: nHold ? deg(worldErr / nHold) : NaN,
    kickAnkleZ: nHold ? ankleZ / nHold : NaN, plannedWorldErrDeg: planned.worldErrDeg, plannedLeanDeg: planned.leanDeg, hipTauFrac: hips.peakTauFrac, hipWorst: hips.worstJoint,
    kickHipTauFrac: Object.fromEntries(['hip_pitch_l', 'hip_roll_l', 'hip_yaw_l'].map((j) => [j, +rec.peaks.get(j)!.tauFrac.toFixed(3)])),
    supportTauFrac: sup.peakTauFrac, ankleStopS: ankleStop,
    supportPeaks: Object.fromEntries(['hip_pitch_r', 'hip_roll_r', 'hip_yaw_r', 'knee_r', 'ankle_pitch_r', 'ankle_roll_r'].map((j) => { const pk = rec.peaks.get(j)!; return [j, { tau: +pk.tauFrac.toFixed(3), satS: +pk.satS.toFixed(3) }]; })),
    derated: [...rec.derated], planComErrMm: 1000 * Math.hypot(last[0], last[1]),
  };
  kin.dispose();
  sim.dispose();
  return out;
}

// ---------------------------------------------------------------- knee snap (armature probe)

/**
 * Gantry knee snap: thigh held level forward (the front-kick fit), shin chambered at 90°, then the
 * knee target steps to straight. Time to 90% of the extension and the peak knee speed: where a big
 * reflected armature (P′) should show, since the shin alone is light.
 */
export async function kneeSnap(v: Variant) {
  const k = KICKS.find((x) => x.id === 'front')!;
  const q = kickSolution(v, k);
  const sim = await makeVSim(v, { lift: 0.45 });
  setTargets(sim.r, { hip_pitch_l: q.p, hip_roll_l: q.r, hip_yaw_l: q.y, knee_l: Math.PI / 2, ankle_pitch_l: 0 });
  sim.run(1.0);
  const j = sim.r.joints[sim.r.jointIndex.get('knee_l')!];
  const q0 = sim.ctx.data.qpos[j.qadr];
  setTargets(sim.r, { knee_l: 0 });
  const rec = new Recorder(sim);
  let t90 = NaN, peak = 0;
  for (let i = 0; i < 600; i++) {
    sim.step();
    rec.sample();
    const qk = sim.ctx.data.qpos[j.qadr];
    peak = Math.max(peak, Math.abs(sim.ctx.data.qvel[j.dadr]));
    if (Number.isNaN(t90) && qk <= 0.1 * q0) t90 = (i + 1) * sim.ctx.dt;
  }
  sim.dispose();
  return { t90S: t90, peakKneeRadS: peak, noLoadRadS: j.motor.noLoadSpeedRadS, kneeTauFrac: rec.peaks.get('knee_l')!.tauFrac };
}
