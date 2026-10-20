// Measuring a polished move against today's baseline (move-polish.md §9.2), through the same worker
// pool and the same physics the polish ran on. Three playbacks of the same clip from the same start:
//   raw        the retargeted clip played plainly on the servos: MotionPlayer's rate table at today's
//              wanted speed, velocity feed-forward, nothing else (PolishedPlayer with zero Δq, no
//              feedback, which reproduces MotionPlayer exactly: tests/polish)
//   raw+fb     the same plus the polished move's feedback law and reference (what the stabiliser alone buys)
//   polished   the stored file, decoded exactly as the game loads it
// Each gets the nominal (traced for the comparison view), 20 seeds of a 0.3-0.6 m/s torso push at a
// random moment of the move, and 20 seeds with one random joint damaged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sample } from '../../src/robots/motions';
import { decodePolish, type PolishJson } from '../../src/robots/motions/polish/format';
import { readPolishFromDisk } from '../../src/robots/motions/polish/load';
import { compatHash } from '../../src/robots/motions/polish/hash';
import { KNOT_S, PlanState, TAIL_S } from './plan';
import type { Pool } from './pool';
import type { PlanData } from './protocol';
import { refAt, refContacts, FOOT_BITS, type Reference } from './reference';
import { TRACE_STRIDE, type Perturb } from './rollout';
import { MoveSession } from './session';
import { readIndex, writeIndex, POLISHED_DIR } from './store';
import { Rng } from './world';

export interface Metrics {
  fell: boolean;
  /** Wall time of the fall (torso past 60°), s after the clock started; null if it stood. Tracking
   *  numbers stop there: a body on the canvas still "tracks" its joint targets. */
  fellAtS: number | null;
  jointRmsDeg: number;
  legRmsDeg: number;
  rootErrCm: number;
  comErrCm: number;
  impactErrCm: number | null;
  impactSpeed: number | null;
  impactSpeedShare: number | null; // × the clip's peak speed at 1×
  strikerPeakSpeed: number | null;
  slipCm: number; // worst planted-sole slide in one stance phase
  slipTotalCm: number;
  torsoHfRms: number; // torso angular rate above ~3 Hz, rad/s (the move's own trunk rotation included)
  torsoBuzzRms: number; // the same on the torso rate's deviation from the clip's (the shake the clip does not have)
  pelvisJerkRms: number; // m/s³
  jointJerkRms: number; // rad/s³
  peakTorqueShare: number;
  peakSpeedShare: number;
  legSatShare: number; // share of samples with a planted-leg servo ≥ 0.85 of its available torque
  heatRiseC: number;
  gyroPeak: number;
  spinDeg: number; // pelvis heading change from the clock start to the clip's end, unwrapped
  clipSpinDeg: number;
  wallS: number; // the move (clock start → clip end)
  clipS: number;
  speedUp: number; // clip / wall
  pushFalls: number;
  damageFalls: number;
  seeds: number;
}

export interface Variant {
  name: 'raw' | 'raw+fb' | 'polished';
  plan: PlanData;
  feedback: boolean;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Metrics of one traced nominal run against the clip. */
export function traceMetrics(ref: Reference, tr: Float64Array, n: number, joints: Array<{ lib: number; leg: boolean }>): Omit<Metrics, 'pushFalls' | 'damageFalls' | 'seeds'> {
  const S = TRACE_STRIDE, m = ref.move;
  const at = (i: number, c: number) => tr[i * S + c];
  let jSum = 0, jN = 0, lSum = 0, lN = 0, rootSum = 0, comSum = 0, cN = 0;
  let fell = false, wallS = -1, fellAt: number | null = null;
  let impactErr: number | null = null, impactSpeed: number | null = null, strikerPeak: number | null = null;
  const smp = sample(m, 0);
  const standing = ref.kind !== 'getup';
  for (let i = 0; i < n; i++) {
    const tau = at(i, 1);
    if (at(i, 53) < 0.5 && !fell) {
      fell = true;
      fellAt = at(i, 0);
    }
    if (wallS < 0 && tau >= m.duration - 1e-9) wallS = at(i, 0);
    if (tau > m.duration) continue;
    if (fell && standing) continue;
    sample(m, tau, { speed: 1, loop: false }, smp);
    joints.forEach((j, ri) => {
      if (j.lib < 0) return;
      const e = at(i, 10 + ri) - smp.q[j.lib];
      jSum += e * e;
      jN++;
      if (j.leg) {
        lSum += e * e;
        lN++;
      }
    });
    let e2 = 0, c2 = 0;
    for (let k = 0; k < 3; k++) {
      e2 += (at(i, 67 + k) - refAt(ref.pelvis, 3, ref, tau, k)) ** 2;
      c2 += (at(i, 33 + k) - refAt(ref.com, 3, ref, tau, k)) ** 2;
    }
    rootSum += e2;
    comSum += c2;
    cN++;
    if (ref.striker && i > 0) {
      const v = Math.hypot(at(i, 47) - at(i - 1, 47), at(i, 48) - at(i - 1, 48), at(i, 49) - at(i - 1, 49)) / (at(i, 0) - at(i - 1, 0));
      if (tau >= m.phases.strike && tau <= m.phases.recover) strikerPeak = Math.max(strikerPeak ?? 0, v);
      if (impactErr === null && m.impact !== null && tau >= m.impact) {
        const tw = [0, 1, 2].map((k) => refAt(ref.striker!, 3, ref, m.impact!, k));
        impactErr = Math.hypot(at(i, 47) - tw[0], at(i, 48) - tw[1], at(i, 49) - tw[2]);
        impactSpeed = v;
      }
    }
  }
  if (wallS < 0) wallS = at(n - 1, 0);
  // Slip: planted (clip, bridged) and down (sim): the lowest corner's horizontal travel per stance phase.
  let slipMax = 0, slipTot = 0;
  for (let f = 0; f < 2; f++) {
    let phase = 0;
    for (let i = 1; i < n; i++) {
      const tau = Math.min(at(i, 1), m.duration);
      const planted = (refContacts(ref, tau) & FOOT_BITS[f]) !== 0 && at(i, 45 + f) === 1 && at(i - 1, 45 + f) === 1;
      if (planted) {
        const d = Math.hypot(at(i, 61 + f * 3) - at(i - 1, 61 + f * 3), at(i, 62 + f * 3) - at(i - 1, 62 + f * 3));
        // A corner switch (rolling onto another corner) is not a slide.
        if (d < 0.02) phase += d;
      } else {
        slipMax = Math.max(slipMax, phase);
        slipTot += phase;
        phase = 0;
      }
    }
    slipMax = Math.max(slipMax, phase);
    slipTot += phase;
  }
  // Smoothness: torso rate above ~3 Hz (first-order high-pass), pelvis and joint jerk (third differences
  // of a 3-sample moving average, 10 ms samples).
  let hf = 0, hfN = 0, bz = 0;
  const lp = [at(0, 50), at(0, 51), at(0, 52)];
  const a = 0.01 / (0.053 + 0.01);
  const omegaRef = (i: number): number[] => {
    // The clip's torso rate at the played clip time and rate: vee(Ṙ·Rᵀ) from neighbouring frames.
    const tau = at(i, 1);
    if (tau >= m.duration) return [0, 0, 0];
    const f = Math.max(1, Math.min(ref.frames - 2, Math.round(tau * ref.fps)));
    const A = ref.torsoR.subarray((f - 1) * 9, f * 9), B = ref.torsoR.subarray((f + 1) * 9, (f + 2) * 9);
    const k = (ref.fps / 2) * at(i, 2);
    // W = (B − A)·Rᵀ / (2/fps), R ≈ frame f; ω = (W21 − W12, W02 − W20, W10 − W01)/2 (skew part)
    const R = ref.torsoR.subarray(f * 9, (f + 1) * 9);
    const W = (r: number, c: number) => (B[r * 3] - A[r * 3]) * R[c * 3] + (B[r * 3 + 1] - A[r * 3 + 1]) * R[c * 3 + 1] + (B[r * 3 + 2] - A[r * 3 + 2]) * R[c * 3 + 2];
    return [((W(2, 1) - W(1, 2)) / 2) * k, ((W(0, 2) - W(2, 0)) / 2) * k, ((W(1, 0) - W(0, 1)) / 2) * k];
  };
  const lpd = [0, 0, 0];
  let lpdInit = false;
  for (let i = 0; i < n; i++) {
    const wr = omegaRef(i);
    if (!lpdInit) {
      for (let k = 0; k < 3; k++) lpd[k] = at(i, 50 + k) - wr[k];
      lpdInit = true;
    }
    for (let k = 0; k < 3; k++) {
      lp[k] += (at(i, 50 + k) - lp[k]) * a;
      hf += (at(i, 50 + k) - lp[k]) ** 2;
      const dv = at(i, 50 + k) - wr[k];
      lpd[k] += (dv - lpd[k]) * a;
      bz += (dv - lpd[k]) ** 2;
    }
    hfN++;
  }
  const smooth = (c: number, i: number) => (at(Math.max(0, i - 1), c) + at(i, c) + at(Math.min(n - 1, i + 1), c)) / 3;
  const dt = 0.01;
  let pj = 0, pjN = 0, jj = 0, jjN = 0;
  for (let i = 3; i < n - 1; i++) {
    if (at(i, 1) > m.duration) break;
    for (let k = 0; k < 3; k++) {
      const j3 = (smooth(67 + k, i) - 3 * smooth(67 + k, i - 1) + 3 * smooth(67 + k, i - 2) - smooth(67 + k, i - 3)) / (dt * dt * dt);
      pj += j3 * j3;
    }
    pjN++;
    for (let c = 10; c < 33; c++) {
      const j3 = (smooth(c, i) - 3 * smooth(c, i - 1) + 3 * smooth(c, i - 2) - smooth(c, i - 3)) / (dt * dt * dt);
      jj += j3 * j3;
      jjN++;
    }
  }
  let pt = 0, ps = 0, sat = 0, satN = 0, temp = 0, gyro = 0;
  for (let i = 0; i < n; i++) {
    if (at(i, 1) > m.duration) continue;
    pt = Math.max(pt, at(i, 55));
    ps = Math.max(ps, at(i, 56));
    if (at(i, 57) >= 0.85) sat++;
    satN++;
    temp = Math.max(temp, at(i, 58));
    gyro = Math.max(gyro, at(i, 54));
  }
  // Spin achieved: unwrapped pelvis yaw from the first sample to the clip's end.
  // Heading off the pelvis's lateral axis (defined lying down too, unlike a yaw angle).
  const yawAt = (i: number) => {
    const w = at(i, 6), x = at(i, 7), y = at(i, 8), z = at(i, 9);
    return Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z));
  };
  let spin = 0, prevYaw = yawAt(0);
  for (let i = 1; i < n; i++) {
    if (at(i, 1) > m.duration) break;
    const yw = yawAt(i);
    let d = yw - prevYaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    spin += d;
    prevYaw = yw;
  }
  return {
    fell,
    fellAtS: fellAt === null ? null : r3(fellAt),
    spinDeg: r3(spin * 57.2958),
    clipSpinDeg: r3(m.spin * 57.2958),
    jointRmsDeg: r3(Math.sqrt(jSum / Math.max(1, jN)) * 57.2958),
    legRmsDeg: r3(Math.sqrt(lSum / Math.max(1, lN)) * 57.2958),
    rootErrCm: r3(Math.sqrt(rootSum / Math.max(1, cN)) * 100),
    comErrCm: r3(Math.sqrt(comSum / Math.max(1, cN)) * 100),
    impactErrCm: impactErr === null ? null : r3(impactErr * 100),
    impactSpeed: impactSpeed === null ? null : r3(impactSpeed),
    impactSpeedShare: impactSpeed === null || !m.peakSpeed ? null : r3(impactSpeed / m.peakSpeed),
    strikerPeakSpeed: strikerPeak === null ? null : r3(strikerPeak),
    slipCm: r3(slipMax * 100),
    slipTotalCm: r3(slipTot * 100),
    torsoHfRms: r3(Math.sqrt(hf / Math.max(1, hfN))),
    torsoBuzzRms: r3(Math.sqrt(bz / Math.max(1, hfN))),
    pelvisJerkRms: r3(Math.sqrt(pj / Math.max(1, pjN))),
    jointJerkRms: r3(Math.sqrt(jj / Math.max(1, jjN))),
    peakTorqueShare: r3(pt),
    peakSpeedShare: r3(ps),
    legSatShare: r3(sat / Math.max(1, satN)),
    heatRiseC: r3(temp - 30),
    gyroPeak: r3(gyro),
    wallS: r3(wallS),
    clipS: r3(m.duration),
    speedUp: r3(m.duration / Math.max(1e-6, wallS)),
  };
}

/**
 * A get-up is up at the end when the pelvis is at 80% of standing height or more and the torso is at
 * least as upright as the clip's own last frame (less 0.15): the CMU actors end these get-ups bent ~40°
 * forward, and a robot that ends exactly like the actor is up.
 */
export function getupUp(ref: Reference, torsoUpZ: number, pelvisZ: number, standZ: number): boolean {
  const clipEndUp = ref.torsoUp[(ref.frames - 1) * 3 + 2];
  return pelvisZ > 0.8 * standZ && torsoUpZ > Math.min(0.8, clipEndUp - 0.15);
}

/** Did a perturbed run fall? Standing moves: torso past 60° at any time; get-ups: not up at the end. */
function runFell(ref: Reference, tr: Float64Array, n: number, standZ: number): boolean {
  const S = TRACE_STRIDE;
  if (ref.kind === 'getup') {
    const o = (n - 1) * S;
    return !getupUp(ref, tr[o + 53], tr[o + 69], standZ);
  }
  for (let i = 0; i < n; i++) if (tr[i * S + 53] < 0.5) return true;
  return false;
}

export function validationPerturbs(design: string, moveId: string, wallS: number, mass: number, nJoints: number, seeds: number): { push: Perturb[]; damage: Perturb[] } {
  const rng = new Rng(0x5eed + design.length * 7919 + moveId.length);
  const u = (a: number, b: number) => a + (b - a) * rng.next();
  const push: Perturb[] = [], damage: Perturb[] = [];
  for (let s = 0; s < seeds; s++) {
    const ang = u(0, 2 * Math.PI), dv = u(0.3, 0.6), J = dv * mass;
    push.push({ push: { t: u(0.05, Math.max(0.1, wallS)), fx: (Math.cos(ang) * J) / 0.1, fy: (Math.sin(ang) * J) / 0.1, dur: 0.1 }, rngSeed: 1000 + s });
  }
  for (let s = 0; s < seeds; s++) {
    const joint = Math.floor(u(0, nJoints)) % nJoints;
    damage.push({ damage: [{ joint, health: u(0.4, 0.6), slop: u(0.02, 0.05) }], rngSeed: 2000 + s });
  }
  return { push, damage };
}

export interface MoveReport {
  design: string;
  moveId: string;
  stale: boolean;
  hash: string;
  cpuS: number;
  metrics: Record<Variant['name'], Metrics>;
  traces: Record<Variant['name'], { fps: number; n: number; wall: number[]; tau: number[]; root: number[]; q: number[] }>;
}

/** Measure one polished move with its baselines; writes the comparison traces and the validation. */
export async function measureMove(pool: Pool, design: string, moveId: string, seeds = 20, log: (s: string) => void = console.log): Promise<MoveReport | null> {
  const json = readPolishFromDisk(design, moveId) as PolishJson | null;
  if (!json) {
    log(`measure ${design}/${moveId}: no polish file`);
    return null;
  }
  const hash = compatHash(design);
  const stale = json.hash !== hash;
  if (stale) log(`measure ${design}/${moveId}: STALE (stored ${json.hash}, robot now ${hash}): measuring on today's robot`);
  const pm = decodePolish(json);
  const ses = await MoveSession.create(design, moveId);
  const key = `measure/${design}/${moveId}`;
  const base = new PlanState(ses.spec);
  const pol: PlanData = {
    dq: Float64Array.from(pm.dq), warp: new Float64Array(base.warp.length), gyroFF: pm.gyroFF ? Float64Array.from(pm.gyroFF) : null,
    fb: pm.fb, deadband: pm.deadband, rates: Float64Array.from(pm.rates),
  };
  const raw: PlanData = {
    dq: new Float64Array(base.dq.length), warp: new Float64Array(base.warp.length), gyroFF: null,
    fb: { ankleD: 0, ankleV: 0, hipTilt: 0, gyroD: 0, gyroV: 0, gyroL: 0, clamp: 0.15 }, deadband: pm.deadband, rates: Float64Array.from(ses.spec.baseRates),
  };
  const rawFb: PlanData = { ...raw, fb: pm.fb };
  const variants: Variant[] = [
    { name: 'raw', plan: raw, feedback: false },
    { name: 'raw+fb', plan: rawFb, feedback: true },
    { name: 'polished', plan: pol, feedback: true },
  ];
  const joints = ses.w.r.joints.map((j, i) => ({ lib: ses.w.joints[i].lib, leg: /^(hip|knee|ankle)/.test(j.name) }));
  const out = { metrics: {}, traces: {} } as Pick<MoveReport, 'metrics' | 'traces'>;
  const standZ = ses.w.stancePelvisZ;
  for (const v of variants) {
    const nomRun = (await pool.full({ type: 'full', design, moveId, plan: v.plan, nominal: pm.nominal ? Float64Array.from(pm.nominal) : null, nominalSamples: pm.nominalSamples, feedback: v.feedback, perturbs: [], trace: true, recordNominal: false }, key)).runs[0];
    const tm = traceMetrics(ses.ref, nomRun.trace!, nomRun.traceN, joints);
    const { push, damage } = validationPerturbs(design, moveId, tm.wallS, ses.w.mass, ses.w.r.joints.length, seeds);
    const pr = await pool.fullMany({ type: 'full', design, moveId, plan: v.plan, nominal: null, nominalSamples: 0, feedback: v.feedback, perturbs: push, trace: true, recordNominal: false }, key);
    const dr = await pool.fullMany({ type: 'full', design, moveId, plan: v.plan, nominal: null, nominalSamples: 0, feedback: v.feedback, perturbs: damage, trace: true, recordNominal: false }, key);
    const falls = (runs: typeof pr.runs) => runs.filter((r) => runFell(ses.ref, r.trace!, r.traceN, standZ)).length;
    const nomFell = ses.ref.kind === 'getup' ? runFell(ses.ref, nomRun.trace!, nomRun.traceN, standZ) : tm.fell;
    out.metrics[v.name] = { ...tm, fell: nomFell, fellAtS: ses.ref.kind === 'getup' ? null : tm.fellAtS, pushFalls: falls(pr.runs), damageFalls: falls(dr.runs), seeds };
    // Comparison-view trace: 50 Hz, root (7) and joints (robot order = library order here).
    const S = TRACE_STRIDE, tr = nomRun.trace!;
    const wall: number[] = [], tau: number[] = [], root: number[] = [], q: number[] = [];
    for (let i = 0; i < nomRun.traceN; i += 2) {
      wall.push(+tr[i * S].toFixed(3));
      tau.push(+tr[i * S + 1].toFixed(4));
      for (let k = 0; k < 7; k++) root.push(+tr[i * S + 3 + k].toFixed(4));
      for (let k = 0; k < 23; k++) q.push(+tr[i * S + 10 + k].toFixed(4));
    }
    out.traces[v.name] = { fps: 50, n: wall.length, wall, tau, root, q };
    const mm = out.metrics[v.name];
    log(`measure ${design}/${moveId} ${v.name.padEnd(8)} fell ${mm.fell} push falls ${mm.pushFalls}/${seeds} damage falls ${mm.damageFalls}/${seeds} joint ${mm.jointRmsDeg}° legs ${mm.legRmsDeg}° root ${mm.rootErrCm} cm com ${mm.comErrCm} cm slip ${mm.slipCm} cm buzz ${mm.torsoBuzzRms} (HF ${mm.torsoHfRms}) jerk ${mm.pelvisJerkRms} legSat ${mm.legSatShare} heat +${mm.heatRiseC}°C wall ${mm.wallS}/${mm.clipS} s (×${mm.speedUp})${mm.impactErrCm !== null ? ` impact ${mm.impactErrCm} cm at ${mm.impactSpeed} m/s (${mm.impactSpeedShare}× peak)` : ''}`);
  }
  const report: MoveReport = { design, moveId, stale, hash: json.hash, cpuS: json.cpuS ?? 0, ...out };
  // Comparison traces next to the move (traces/ is outside the runtime loader's glob).
  const dir = join(POLISHED_DIR, design, 'traces');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${moveId}.json`), JSON.stringify({
    format: 1, design, move: moveId, clipS: ses.spec.move.duration, knotS: KNOT_S, tailS: TAIL_S, stale, hash: json.hash, cpuS: report.cpuS,
    metrics: report.metrics, traces: report.traces, joints: ses.w.r.joints.map((j) => j.name),
  }) + '\n');
  // Validation summary into the polish file and the design index.
  json.validation = { measuredAt: new Date().toISOString(), stale, ...Object.fromEntries(Object.entries(report.metrics).map(([k, m]) => [k, m])) };
  writeFileSync(join(POLISHED_DIR, design, `${moveId}.json`), JSON.stringify(json) + '\n');
  const ix = readIndex(design);
  if (ix.moves[moveId]) ix.moves[moveId].validation = { polished: report.metrics.polished, raw: report.metrics.raw };
  writeIndex(ix);
  return report;
}

// CLI: npx tsx tools/polish/measure.ts --workers 3 [--only savate/cross.13_17.1024,...] [--seeds 20]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Pool } = await import('./pool');
  const { QUEUES } = await import('./queues');
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const list = (arg('only') ?? QUEUES[arg('queue', 'poc')!].join(',')).split(',');
  const pool = new Pool(Math.min(5, Number(arg('workers', '3'))), null);
  for (const id of list) {
    const [d, m] = id.split('/');
    await measureMove(pool, d, m, Number(arg('seeds', '20')));
  }
  pool.close();
}
