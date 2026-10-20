// Phase 0 get-ups (next-gen-chassis.md §6 step 2, on the tests/control/getup-search.ts pattern):
// drop the robot on its back or face down and play SAVATE's best human get-up clip from its motion
// library (the ones its production get-up plan ranks first: getup_back.140_08.0076 and
// getup_face_down.140_02.0128), then rise to the stance. Every variant plays the SAME physical
// motion: hip angles go through each variant's own hip (closed-form IK, clamped to its ranges) and
// every other joint is clamped to its range. A cross-entropy search with the SAME budget for every
// variant tunes eight playback numbers (pace, where to cut to the rise, rise time, five posture
// offsets). Motor model on (torque-speed, heat, battery), no gyro, no production controller; only
// the rise gets help, from the same double-support ankle law for every variant.
// Score: seconds from the first movement to the stand gate (torso within ~32° of upright, pelvis at
// ≥ 80% of the spawn height, only the soles on the canvas, held 0.5 s). Runs that reach a thermal
// derate band are rejected.
import { readFileSync } from 'node:fs';
import { anyContact } from '../../src/physics/control/contacts';
import { parseLibrary } from '../../src/robots/motions/library';
import type { Move } from '../../src/robots/motions/types';
import { clampHip, fkHip, ikHip } from './hipik';
import { apply, sub, tr, xmatAt, v3At, type V3 } from './math3';
import { mulberry32, gauss, minJerk } from './opt';
import { liveSole } from './kin';
import { rangeOf } from './tests-kick';
import { makeVSim, Recorder, setTargets, bodyId, type VSim } from './sim';
import { hipRangesOf, type Variant } from './variants';

export type Lie = 'back' | 'face_down';
const ORIENT: Record<Lie, [number, number, number, number]> = {
  back: [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0],
  face_down: [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 0],
};
export const CLIP: Record<Lie, string> = { back: 'getup_back.140_08.0076', face_down: 'getup_face_down.140_02.0128' };

let lib: ReturnType<typeof parseLibrary> | null = null;
function clip(lie: Lie): { move: Move; joints: string[] } {
  lib ??= parseLibrary(JSON.parse(readFileSync(new URL('../../src/robots/motions/data/savate.json', import.meta.url), 'utf8')));
  return { move: lib.move(CLIP[lie]), joints: [...lib.joints] };
}

/** Playback parameters the search tunes. */
const P_FIELDS = ['pace', 'cut', 'rise', 'waist', 'hip', 'knee', 'ankle', 'arm'] as const;
export type Params = Record<(typeof P_FIELDS)[number], number>;
export const P0: Params = { pace: 1, cut: 0.92, rise: 0.7, waist: 0, hip: 0, knee: 0, ankle: 0, arm: 0 };
const PSD: Params = { pace: 0.15, cut: 0.06, rise: 0.15, waist: 0.12, hip: 0.12, knee: 0.12, ankle: 0.08, arm: 0.2 };
const PLO: Params = { pace: 0.6, cut: 0.6, rise: 0.3, waist: -0.5, hip: -0.5, knee: -0.5, ankle: -0.3, arm: -0.8 };
const PHI: Params = { pace: 1.8, cut: 1.0, rise: 1.4, waist: 0.5, hip: 0.5, knee: 0.5, ankle: 0.3, arm: 0.8 };

/** Clip frame at clip time τ (s) as this variant's joint targets. */
function frameTargets(sim: VSim, v: Variant, m: Move, joints: string[], tau: number, p: Params): Record<string, number> {
  const fr = Math.min(m.frames - 1, Math.max(0, tau * m.fps));
  const i = Math.min(m.frames - 2, Math.floor(fr)), f = fr - i;
  const nj = joints.length;
  const raw: Record<string, number> = {};
  joints.forEach((n, j) => { raw[n] = m.q[i * nj + j] + f * (m.q[(i + 1) * nj + j] - m.q[i * nj + j]); });
  raw.waist_pitch += p.waist;
  for (const s of ['l', 'r'] as const) {
    raw[`hip_pitch_${s}`] += p.hip;
    raw[`knee_${s}`] += p.knee;
    raw[`ankle_pitch_${s}`] += p.ankle;
    raw[`shoulder_pitch_${s}`] += p.arm;
  }
  const q: Record<string, number> = {};
  for (const n of joints) q[n] = raw[n];
  // The clip's hips are stock-layout angles: carry the thigh orientation through this variant's hip.
  for (const s of ['l', 'r'] as const) {
    const R = fkHip('stock', s, { p: raw[`hip_pitch_${s}`], r: raw[`hip_roll_${s}`], y: raw[`hip_yaw_${s}`] });
    const h = clampHip(ikHip(v.layout, s, R), hipRangesOf(v, s));
    q[`hip_pitch_${s}`] = h.p; q[`hip_roll_${s}`] = h.r; q[`hip_yaw_${s}`] = h.y;
  }
  for (const n of joints) { const [lo, hi] = rangeOf(sim, n); q[n] = Math.min(hi, Math.max(lo, q[n])); }
  return q;
}

export interface GetupTrial { ok: boolean; standS: number; why: string; progress: number; peakTauFrac: number; worstJoint: string; peakSpeedFrac: number; peakTempC: number; derated: string[]; maxSatS: number; /** §6: longest time any ankle joint spent within 1° of a stop (recorded trials only). */ ankleStopS: number }

const STAND_HOLD_S = 0.5;
const BLEND_S = 0.3; // lying pose → first clip frame

export async function trial(v: Variant, lie: Lie, p: Params, seed: number, record = false): Promise<GetupTrial> {
  const rng = mulberry32(5000 + seed);
  const sim = await makeVSim(v, { seed });
  sim.release();
  const { ctx } = sim;
  const r = sim.r;
  const a = r.rootQadr;
  // Lying on the back / front, with per-seed yaw and roll jitter, dropped from 0.3 m.
  const q0 = ORIENT[lie];
  const yaw = 0.3 * gauss(rng), roll = 0.08 * gauss(rng);
  const qz = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], qx = [Math.cos(roll / 2), Math.sin(roll / 2), 0, 0];
  const mulQ = (x: number[], y: number[]) => [x[0] * y[0] - x[1] * y[1] - x[2] * y[2] - x[3] * y[3], x[0] * y[1] + x[1] * y[0] + x[2] * y[3] - x[3] * y[2], x[0] * y[2] - x[1] * y[3] + x[2] * y[0] + x[3] * y[1], x[0] * y[3] + x[1] * y[2] - x[2] * y[1] + x[3] * y[0]];
  const q = mulQ(mulQ(qz, q0), qx);
  ctx.data.qpos[a + 2] = 0.3;
  for (let i = 0; i < 4; i++) ctx.data.qpos[a + 3 + i] = q[i];
  sim.mj.mj_forward(ctx.model, ctx.data);
  sim.run(1.2); // settle on the canvas at stance targets
  const { move, joints } = clip(lie);
  const pace = p.pace * (1 + 0.04 * gauss(rng));
  const cutTau = p.cut * move.duration;
  const tCut = BLEND_S + cutTau / pace;
  const tRise = tCut + p.rise;
  const stance: Record<string, number> = { ...r.design.stance };
  const lying: Record<string, number> = {};
  for (const j of r.joints) lying[j.name] = r.targets[r.jointIndex.get(j.name)!];
  const first = frameTargets(sim, v, move, joints, 0, p);
  const cutPose = frameTargets(sim, v, move, joints, cutTau, p);
  const total = tRise + 2.0;
  const rec = record ? new Recorder(sim) : null;
  const pelvis = bodyId(sim, 'pelvis'), torso = bodyId(sim, 'torso');
  const standZ = 0.8 * r.design.rootHeight;
  const soles = new Set([...r.parts.get('foot_l')!.geoms, ...r.parts.get('foot_r')!.geoms]);
  const robotGeoms = new Set([...r.parts.values()].flatMap((x) => x.geoms));
  let gateSince = -1, standS = NaN, progress = 0;
  let prevE: [number, number] | null = null, eDot: [number, number] = [0, 0];
  const n = Math.round(total / ctx.dt);
  let derated = false;
  for (let i = 0; i < n; i++) {
    const t = i * ctx.dt;
    let cur: Record<string, number>;
    if (t < BLEND_S) {
      const s = minJerk(t / BLEND_S);
      cur = {};
      for (const nm of Object.keys(first)) cur[nm] = lying[nm] + s * (first[nm] - lying[nm]);
    } else if (t < tCut) {
      cur = frameTargets(sim, v, move, joints, (t - BLEND_S) * pace, p);
    } else {
      // The rise: cut pose → stance, with the double-support ankle law on the COM vs the soles' midpoint.
      const s = minJerk((t - tCut) / p.rise);
      cur = {};
      for (const nm of Object.keys(cutPose)) cur[nm] = cutPose[nm] + s * ((stance[nm] ?? 0) - cutPose[nm]);
      if (i % 2 === 0) {
        const L = liveSole(sim, 'l'), R = liveSole(sim, 'r');
        const mid: V3 = [(L.sole[0] + R.sole[0]) / 2, (L.sole[1] + R.sole[1]) / 2, 0];
        const P = xmatAt(ctx.data.xmat, pelvis);
        const hy = Math.atan2(P[3], P[0]);
        const H = [Math.cos(hy), -Math.sin(hy), 0, Math.sin(hy), Math.cos(hy), 0, 0, 0, 1];
        const c = apply(tr(H), sub(v3At(ctx.data.subtree_com, r.rootBody), mid));
        const e: [number, number] = [c[0], c[1]];
        if (prevE) eDot = [0.7 * eDot[0] + 0.3 * (e[0] - prevE[0]) / (2 * ctx.dt), 0.7 * eDot[1] + 0.3 * (e[1] - prevE[1]) / (2 * ctx.dt)];
        prevE = e;
        for (const sd of ['l', 'r']) {
          cur[`ankle_pitch_${sd}`] += s * (1.2 * e[0] + 0.3 * eDot[0]);
          cur[`ankle_roll_${sd}`] += s * -(1.2 * e[1] + 0.3 * eDot[1]);
        }
      }
    }
    setTargets(r, cur);
    sim.step();
    rec?.sample();
    if (!record && i % 20 === 0) for (const j of r.joints) if (j.tempC > j.motor.maxTempC - 20) derated = true;
    if (i % 10 !== 0) continue;
    const pz = ctx.data.xpos[pelvis * 3 + 2];
    const up = ctx.data.xmat[torso * 9 + 8];
    if (process.env.NG_DEBUG && i % 100 === 0) console.log(`t ${t.toFixed(2)} ${t < BLEND_S ? 'blend' : t < tCut ? 'clip' : 'rise'} pelvis z ${pz.toFixed(2)} up ${up.toFixed(2)}`);
    progress = Math.max(progress, Math.min(1, pz / standZ) * 0.6 + Math.max(0, up) * 0.4);
    const gate = up > 0.85 && pz > standZ && !anyContact(ctx.data, (g1, g2) => (g1 === 0 && robotGeoms.has(g2) && !soles.has(g2)) || (g2 === 0 && robotGeoms.has(g1) && !soles.has(g1)));
    if (gate) {
      if (gateSince < 0) gateSince = t;
      if (t - gateSince >= STAND_HOLD_S) { standS = gateSince; break; }
    } else gateSince = -1;
  }
  const sum = rec?.summary(['hip_', 'knee_', 'ankle_', 'waist_', 'shoulder_', 'elbow_']);
  if (rec && rec.derated.size) derated = true;
  sim.dispose();
  const ok = Number.isFinite(standS) && !derated;
  return {
    ok, standS, why: ok ? '' : derated ? 'thermal derate' : 'no stand', progress,
    peakTauFrac: sum?.peakTauFrac ?? NaN, worstJoint: sum?.worstJoint ?? '', peakSpeedFrac: sum?.peakSpeedFrac ?? NaN, peakTempC: sum?.peakTempC ?? NaN,
    derated: rec ? [...rec.derated] : [], maxSatS: sum?.maxSatS ?? NaN,
    ankleStopS: rec ? Math.max(...['ankle_pitch_l', 'ankle_pitch_r', 'ankle_roll_l', 'ankle_roll_r'].map((j) => rec.peaks.get(j)!.limitS)) : NaN,
  };
}

/** Search score: stand time if up, else 10 + shortfall. */
const score = (t: GetupTrial) => (t.ok ? t.standS : 10 + 10 * (1 - t.progress));
const toX = (p: Params) => P_FIELDS.map((f) => p[f]);
const toP = (x: number[]) => Object.fromEntries(P_FIELDS.map((f, i) => [f, x[i]])) as Params;

export async function getup(v: Variant, lie: Lie, budget = Number(process.env.NG_GETUP_BUDGET ?? 120)) {
  const t0 = Date.now();
  const pop = 12;
  const iters = Math.max(1, Math.round(budget / pop));
  const lo = toX(PLO), hi = toX(PHI);
  const clampV = (x: number[]) => x.map((y, i) => Math.min(hi[i], Math.max(lo[i], y)));
  let rollouts = 0;
  const evalX = async (x: number[]) => {
    const a = await trial(v, lie, toP(x), 1);
    rollouts++;
    // A second drop for anything promising, so one lucky landing can't win.
    if (!(a.ok || a.progress > 0.75)) return score(a);
    const b = await trial(v, lie, toP(x), 2);
    rollouts++;
    return 0.5 * (score(a) + score(b));
  };
  const rng = mulberry32(77);
  let mean = toX(P0);
  let sd = toX(PSD);
  let best = { x: mean, f: await evalX(mean) };
  const base = best.f;
  for (let it = 0; it < iters; it++) {
    const samples: Array<{ x: number[]; f: number }> = [best];
    for (let k = 0; k < pop - 1; k++) {
      const x = clampV(mean.map((m, i) => m + sd[i] * gauss(rng)));
      samples.push({ x, f: await evalX(x) });
    }
    samples.sort((a, b) => a.f - b.f);
    if (samples[0].f < best.f) best = samples[0];
    const el = samples.slice(0, 4);
    mean = mean.map((_, i) => el.reduce((s, e) => s + e.x[i], 0) / el.length);
    sd = sd.map((_, i) => Math.max(0.01, 0.3 * sd[i] + 0.7 * Math.sqrt(el.reduce((s, e) => s + (e.x[i] - mean[i]) ** 2, 0) / el.length)));
    if (process.env.NG_VERBOSE) console.log(`  ${v.label} ${lie} CE ${it + 1}/${iters}: best ${best.f.toFixed(2)}`);
  }
  // The winner on 5 seeds with the full honesty recorder.
  const evals: GetupTrial[] = [];
  for (let s = 1; s <= 5; s++) evals.push(await trial(v, lie, toP(best.x), s, true));
  const ups = evals.filter((e) => e.ok);
  const sorted = ups.map((e) => e.standS).sort((x, y) => x - y);
  const out = {
    lie, clip: CLIP[lie], rollouts, wallS: (Date.now() - t0) / 1000, baselineScore: base, bestScore: best.f,
    successes: ups.length,
    medianStandS: sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN,
    bestStandS: sorted.length ? sorted[0] : NaN,
    peakTauFrac: Math.max(...evals.map((e) => e.peakTauFrac)),
    peakSpeedFrac: Math.max(...evals.map((e) => e.peakSpeedFrac)),
    peakTempC: Math.max(...evals.map((e) => e.peakTempC)),
    worstJoints: [...new Set(evals.map((e) => e.worstJoint))],
    ankleStopS: Math.max(...evals.map((e) => e.ankleStopS)),
    derated: [...new Set(evals.flatMap((e) => e.derated))],
    trials: evals,
    params: toP(best.x),
  };
  console.log(`${v.label} getup ${lie}: ${out.successes}/5 up, median ${out.medianStandS.toFixed(2)} s, best ${out.bestStandS.toFixed(2)} s, peak τ/stall ${out.peakTauFrac.toFixed(2)} ω/ω0 ${out.peakSpeedFrac.toFixed(2)} ${out.peakTempC.toFixed(1)}°C derated ${out.derated.join(',') || 'none'} (search ${base.toFixed(2)} → ${best.f.toFixed(2)}, ${rollouts} rollouts, ${out.wallS.toFixed(0)} s)`);
  return out;
}
