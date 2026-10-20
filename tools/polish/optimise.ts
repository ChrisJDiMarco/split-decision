// Polishing one move (move-polish.md §3): windowed sep-CMA-ES over the B-spline corrections, rolled
// out through PolishedPlayer and the game's physics by the worker pool.
//   per window   ILC warm start (all joints, kept only if it lowers the cost) → Pass A (nominal) →
//                IPOP restart / merge with the previous window if every candidate falls → Pass B
//                (robust over K scenarios, F = mean + 0.5·max) → commit (re-simulated, snapshot at the
//                next window's start) → ILC on the joints the search does not sample → checkpoint
//   after        the plan is quantized as stored, the open-loop nominal recorded, the feedback gains
//                optimised over whole-move perturbed rollouts, and the nominal replay with feedback on
//                checked to be bit-identical to the open-loop one
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { sample } from '../../src/robots/motions';
import { NOMINAL_STRIDE, quantize, quantizeNominal, RATE_STEP, GYRO_STEP, DEFAULT_FEEDBACK, type DeadBands, type FeedbackGains } from '../../src/robots/motions/polish/format';
import { QUANT } from '../../src/robots/motions/types';
import { newSplineEval, splineBasis } from '../../src/robots/motions/polish/spline';
import { SepCMA } from './cma';
import { KNOT_S, LOOKAHEAD_S, PlanState, TAIL_S, readVars, varBounds, windowVars, writeVars, DEFAULT_BANDS, type MoveSpec, type Var } from './plan';
import type { Pool } from './pool';
import type { From, PlanData, WindowCtx } from './protocol';
import { TRACE_STRIDE, type Perturb } from './rollout';
import { MoveSession } from './session';
import { centerMassOverFeet, flattenPlantedFeet } from './warmstart';
import { Rng } from './world';

export interface PolishOpts {
  passAGens: number;
  passBGens: number;
  stall: number;
  gainGens: number;
  /** Scenarios per candidate in Pass B (including the nominal). */
  K?: number;
  checkpoint: string;
  log: (s: string) => void;
  /** Stop after this many windows (pilot runs). */
  maxWindows?: number;
}

export interface PolishOutcome {
  spec: MoveSpec;
  plan: PlanState;
  status: 'polished' | 'failed';
  reason?: string;
  nominal: Float64Array;
  nominalSamples: number;
  wallS: number;
  windowLog: Array<{ k: number; costA0: number; costA: number; costB: number; fell: boolean; gens: number; merges: number }>;
  gainLog: { before: number; after: number; fb: FeedbackGains };
  cpuS: number;
  replayExact: boolean;
  trace: Float64Array | null;
  traceN: number;
  impactErr: number;
  impactSpeed: number;
}

interface Checkpoint {
  design: string;
  moveId: string;
  k: number; // next window
  dq: Float64Array;
  warp: Float64Array;
  gyroFF: Float64Array | null;
  from: From;
  nominal: Float64Array | null;
  hist: Array<{ k: number; from: From; nominal: Float64Array | null; dq: Float64Array; warp: Float64Array; gyroFF: Float64Array | null }>;
  windowLog: PolishOutcome['windowLog'];
  merges: number;
  cpuMs: number;
  failedAt: number | null;
}

const toData = (p: PlanState): PlanData => ({ dq: p.dq, warp: p.warp, gyroFF: p.gyroFF, fb: p.fb, deadband: p.deadband, rates: p.ratesOverride });

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Perturbed scenarios for a window (common random numbers: fixed per move and window). */
export function windowScenarios(spec: MoveSpec, K: number, k: number, startWall: number, mass: number, legJoints: number[]): Perturb[] {
  const rng = new Rng(seedOf(`${spec.design}/${spec.moveId}/${k}`));
  const u = (a: number, b: number) => a + (b - a) * rng.next();
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng.next() * xs.length) % xs.length];
  const all: Array<() => Perturb> = [
    () => ({ kick: { vx: u(-0.15, 0.15), vy: u(-0.15, 0.15), wx: u(-0.3, 0.3), wy: u(-0.3, 0.3) }, rngSeed: 11 + k }),
    () => ({ damage: [{ joint: pick(legJoints), health: 0.7, slop: 0.02 }], heatC: 60, battery: 0.7, gyroHealth: 0.8, rngSeed: 23 + k }),
    () => ({ latencyTicks: 2, kick: { vx: u(-0.08, 0.08), vy: u(-0.08, 0.08), wx: 0, wy: 0 }, rngSeed: 37 + k }),
    () => {
      const ang = u(0, 2 * Math.PI), J = u(10, 25);
      return { push: { t: startWall + u(0.02, 0.18), fx: (Math.cos(ang) * J) / 0.1, fy: (Math.sin(ang) * J) / 0.1, dur: 0.1 } };
    },
    () => ({ damage: [{ joint: pick(legJoints), health: 0.8, slop: 0.015 }], kick: { vx: u(-0.1, 0.1), vy: u(-0.1, 0.1), wx: u(-0.2, 0.2), wy: u(-0.2, 0.2) }, rngSeed: 53 + k }),
  ];
  void mass;
  const out: Perturb[] = [{}];
  for (let i = 0; i < K - 1; i++) out.push(all[i % all.length]());
  return out;
}

/** Whole-move perturbations for the gain pass (pushes at random times, damage, kicks). */
export function gainScenarios(spec: MoveSpec, n: number, wallS: number, mass: number, legJoints: number[]): Perturb[] {
  const rng = new Rng(seedOf(`${spec.design}/${spec.moveId}/gains`));
  const u = (a: number, b: number) => a + (b - a) * rng.next();
  const out: Perturb[] = [];
  for (let i = 0; i < n; i++) {
    const ang = u(0, 2 * Math.PI), dv = u(0.2, 0.45), J = dv * mass;
    const p: Perturb = { push: { t: u(0.05, Math.max(0.1, wallS - 0.1)), fx: (Math.cos(ang) * J) / 0.1, fy: (Math.sin(ang) * J) / 0.1, dur: 0.1 }, rngSeed: 100 + i };
    if (i % 3 === 1) p.damage = [{ joint: legJoints[Math.floor(u(0, legJoints.length)) % legJoints.length], health: 0.6, slop: 0.03 }];
    if (i % 3 === 2) p.kick = { vx: u(-0.15, 0.15), vy: u(-0.15, 0.15), wx: u(-0.3, 0.3), wy: u(-0.3, 0.3) };
    out.push(p);
  }
  return out;
}

let ctxCounter = 0;

const robustF = (cs: number[]): number => {
  const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
  return mean + 0.5 * Math.max(...cs);
};

export async function polishMove(pool: Pool, design: string, moveId: string, o: PolishOpts): Promise<PolishOutcome> {
  const ses = await MoveSession.create(design, moveId);
  const spec = ses.spec, move = spec.move;
  const key = `${design}/${moveId}`;
  const h = KNOT_S;
  const endTau = move.duration + TAIL_S;
  const K = o.K ?? (spec.kind === 'punch' ? 4 : 6);
  const lambdaBase = spec.kind === 'getup' ? 20 : 16;
  const poseScale = spec.kind === 'getup' ? 3 / 8 : 1;
  const legJoints = ses.w.r.joints.map((j, i) => (/^(hip|knee|ankle)/.test(j.name) ? i : -1)).filter((i) => i >= 0);
  const allCh = spec.move.q.length / spec.move.frames;
  const allChannels = Array.from({ length: allCh }, (_, i) => i);
  const unsampled = allChannels.filter((c) => !spec.sampled.includes(c));
  const log = (s: string) => o.log(`[${design} ${moveId}] ${s}`);

  let plan = new PlanState(spec);
  plan.track = ses.track;
  let from: From = { kind: 'placed' };
  let nominal: Float64Array | null = null;
  let k0 = 0;
  let merges = 0;
  let failedAt: number | null = null;
  const windowLog: PolishOutcome['windowLog'] = [];
  let hist: Checkpoint['hist'] = [];
  const cpu0 = pool.cpuByKey.get(key) ?? 0;
  let cpuBase = 0;
  if (existsSync(o.checkpoint)) {
    const c = deserialize(readFileSync(o.checkpoint)) as Checkpoint;
    plan.dq.set(c.dq);
    plan.warp.set(c.warp);
    if (plan.gyroFF && c.gyroFF) plan.gyroFF.set(c.gyroFF);
    from = c.from;
    nominal = c.nominal;
    k0 = c.k;
    hist = c.hist;
    windowLog.push(...c.windowLog);
    merges = c.merges;
    cpuBase = c.cpuMs;
    failedAt = c.failedAt;
    log(`resumed at window ${k0}/${spec.windows}`);
  }
  if (k0 === 0) {
    const fl = flattenPlantedFeet(ses, plan);
    const cm = centerMassOverFeet(ses, plan);
    log(`warm start: ${fl.points} planted-sole points flattened (largest ${fl.maxDeg.toFixed(1)}°), COM moved over the feet at ${cm.points} knots (largest ${cm.maxShiftCm.toFixed(1)} cm)`);
  }
  const cpuNow = () => cpuBase + (pool.cpuByKey.get(key) ?? 0) - cpu0;
  const save = (k: number) => {
    const c: Checkpoint = {
      design, moveId, k, dq: plan.dq, warp: plan.warp, gyroFF: plan.gyroFF, from, nominal, hist: hist.slice(-3), windowLog, merges,
      cpuMs: cpuNow(), failedAt,
    };
    writeFileSync(o.checkpoint, serialize(c));
  };

  const ctxFor = (k: number, vars: Var[], fromK: From, nomK: Float64Array | null, kFirst: number, robustScen: Perturb[], tag: string): WindowCtx => {
    const fromTau = kFirst === 0 ? 0 : 2 * kFirst * h;
    const winEnd = Math.min(endTau, (2 * k + 2) * h);
    return {
      key: `${key}#${k}${tag}:${++ctxCounter}`,
      design, moveId, from: fromK, base: toData(plan), nominal: nomK, nominalSamples: 0, vars,
      fromTau, lookaheadTau: winEnd, untilTau: Math.min(endTau, winEnd + LOOKAHEAD_S), endTau, scenarios: robustScen, poseScale,
    };
  };

  /** One ILC step on `channels` of window k's points; kept only if the nominal cost drops. */
  const ilc = async (k: number, kFirst: number, fromK: From, nomK: Float64Array | null, channels: number[], iters: number): Promise<void> => {
    if (!channels.length) return;
    const vars = windowVars(spec, k, channels, k - kFirst + 1, true);
    for (let it = 0; it < iters; it++) {
      const ctx = ctxFor(k, vars, fromK, nomK, kFirst, [{}], `:ilc${it}`);
      const x = readVars(plan, vars);
      const rep = await pool.commit(ctx, x, null, true, key);
      if (!rep.trace || rep.fell) return;
      const nl = spec.nLib;
      const rates = plan.rates();
      const e = newSplineEval();
      const num = new Float64Array(vars.length), den = new Float64Array(vars.length);
      const idx = new Map<string, number>();
      vars.forEach((v, i) => { if (v.kind === 'dq') idx.set(`${v.point}:${v.ch}`, i); });
      for (let s = 0; s < rep.traceN; s++) {
        const tau = rep.trace[s * (1 + nl)];
        if (tau < ctx.fromTau || tau > ctx.untilTau) continue;
        const f = Math.min(rates.length - 1, Math.max(0, Math.round(tau * move.fps)));
        const lag = 0.03 * (tau < move.duration ? rates[f] : 1);
        const smp = sample(move, Math.min(tau, move.duration), { speed: 1, loop: false });
        splineBasis(tau - lag, h, spec.segments, e);
        for (let b = 0; b < 4; b++) {
          const pt = e.seg + b;
          for (const ch of channels) {
            const vi = idx.get(`${pt}:${ch}`);
            if (vi === undefined) continue;
            const err = smp.q[ch] - rep.trace[s * (1 + nl) + 1 + ch];
            num[vi] += e.w[b] * err;
            den[vi] += e.w[b];
          }
        }
      }
      const x2 = Float64Array.from(x);
      for (let i = 0; i < x2.length; i++) if (den[i] > 1e-6) x2[i] = Math.max(-0.4, Math.min(0.4, x[i] + 0.7 * (num[i] / den[i])));
      const ev = await pool.evaluate(ctx, [x, x2], false, key);
      if (ev.costs[1][0] < ev.costs[0][0]) writeVars(plan, vars, x2);
      else return;
    }
  };

  /** sep-CMA over a window's variables; returns the best point and its fitness. */
  const search = async (ctx: WindowCtx, x0: Float64Array, robust: boolean, gens: number, lambda: number, sigmaScale: number, seed: number) => {
    const b = varBounds(spec, ctx.vars);
    for (let i = 0; i < b.sigma.length; i++) b.sigma[i] *= sigmaScale;
    const cma = new SepCMA({ mean: x0, sigma0: b.sigma, lo: b.lo, hi: b.hi, lambda, seed });
    const first = await pool.evaluate(ctx, [x0], robust, key);
    let bestX = Float64Array.from(x0), bestF = robust ? robustF(first.costs[0]) : first.costs[0][0], bestFell = first.fell[0][0];
    const f0 = bestF;
    let stall = 0, g = 0;
    for (; g < gens; g++) {
      const xs = cma.ask();
      const r = await pool.evaluate(ctx, xs, robust, key);
      const fs = r.costs.map((c) => (robust ? robustF(c) : c[0]));
      cma.tell(xs, fs);
      let improved = false;
      fs.forEach((f, i) => {
        if (f < bestF - 1e-6 * Math.abs(bestF)) {
          if (f < bestF - 1e-3 * Math.max(1, Math.abs(bestF))) improved = true;
          bestF = f;
          bestX = Float64Array.from(xs[i]);
          bestFell = r.fell[i][0];
        }
      });
      stall = improved ? 0 : stall + 1;
      if (stall >= o.stall) break;
    }
    return { x: bestX, f: bestF, f0, fell: bestFell, gens: g };
  };

  for (let k = k0; k < spec.windows; k++) {
    if (o.maxWindows !== undefined && k >= o.maxWindows) break;
    const t0 = Date.now();
    hist.push({ k, from, nominal: nominal ? Float64Array.from(nominal) : null, dq: Float64Array.from(plan.dq), warp: Float64Array.from(plan.warp), gyroFF: plan.gyroFF ? Float64Array.from(plan.gyroFF) : null });
    let kFirst = k;
    let fromK = from, nomK = nominal;
    // ILC warm start on every joint of this window.
    await ilc(k, kFirst, fromK, nomK, allChannels, 2);
    let vars = windowVars(spec, k, spec.sampled);
    const startWall = fromK.kind === 'point' ? fromK.clock.ticks * 0.002 : 0;
    const scen = windowScenarios(spec, K, k, startWall, ses.w.mass, legJoints);
    let ctxA = ctxFor(k, vars, fromK, nomK, kFirst, scen, ':A');
    let a = await search(ctxA, readVars(plan, vars), false, o.passAGens, lambdaBase, 1, seedOf(`${key}A${k}`));
    const costA0 = a.f0;
    if (a.fell) {
      log(`window ${k}: every candidate fell (best ${a.f.toFixed(0)}), IPOP restart`);
      const b = await search(ctxA, a.x, false, o.passAGens, lambdaBase * 2, 1.5, seedOf(`${key}A2${k}`));
      if (b.f < a.f) a = b;
    }
    while (a.fell && merges < 2 && k - kFirst < 2 && kFirst > 0) {
      // Merge with the previous window: re-open its points, start from its snapshot.
      merges++;
      kFirst--;
      const hk = hist.find((x) => x.k === kFirst);
      if (!hk) break;
      fromK = hk.from;
      nomK = hk.nominal;
      plan.dq.set(hk.dq.map((v, i) => (Math.floor(i / spec.nLib) >= 2 * k + 3 ? plan.dq[i] : v)));
      vars = windowVars(spec, k, spec.sampled, k - kFirst + 1);
      ctxA = ctxFor(k, vars, fromK, nomK, kFirst, scen, `:M${kFirst}`);
      log(`window ${k}: merged with window ${kFirst} (${vars.length} variables)`);
      const m = await search(ctxA, readVars(plan, vars), false, o.passAGens, lambdaBase * 2, 1.5, seedOf(`${key}M${k}${kFirst}`));
      if (m.f < a.f || !m.fell) a = m;
    }
    writeVars(plan, vars, a.x);
    if (a.fell && failedAt === null) failedAt = k;
    // Pass B: robust around the Pass A result.
    const ctxB = ctxFor(k, vars, fromK, nomK, kFirst, scen, ':B');
    const bres = a.fell ? { x: a.x, f: a.f, f0: a.f, fell: true, gens: 0 } : await search(ctxB, a.x, true, o.passBGens, lambdaBase, 0.5, seedOf(`${key}B${k}`));
    // Keep B only if its nominal still stands (it may trade a little nominal cost for robustness).
    const check = await pool.evaluate(ctxB, [a.x, bres.x], false, key);
    const useB = !check.fell[1][0] || check.fell[0][0];
    writeVars(plan, vars, useB ? bres.x : a.x);
    // Commit, then ILC on the joints the search does not sample, then commit again for the snapshot.
    await ilc(k, kFirst, fromK, nomK, unsampled, 2);
    const snapAt = (2 * k + 2) * h < endTau - 1e-9 ? (2 * k + 2) * h : null;
    const cctx = ctxFor(k, windowVars(spec, k, spec.sampled, k - kFirst + 1), fromK, nomK, kFirst, [{}], ':C');
    const rep = await pool.commit(cctx, readVars(plan, cctx.vars), snapAt, false, key);
    nominal = rep.nominal;
    if (snapAt !== null) {
      if (!rep.snap || !rep.clock) throw new Error(`window ${k}: commit produced no snapshot`);
      from = { kind: 'point', snap: rep.snap, clock: rep.clock };
    }
    windowLog.push({ k, costA0, costA: a.f, costB: bres.f, fell: rep.fell, gens: a.gens + bres.gens, merges });
    log(`window ${k}/${spec.windows - 1}: A ${costA0.toFixed(1)} → ${a.f.toFixed(1)} (${a.gens} gens${a.fell ? ', FELL' : ''}), B ${bres.f.toFixed(1)} (${bres.gens} gens, ${useB ? 'kept' : 'dropped: nominal fell'}), commit ${rep.cost.toFixed(1)}${rep.fell ? ' FELL' : ''} [${Object.entries(rep.terms).filter(([, v]) => Math.abs(v) > 0.5).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')}] in ${((Date.now() - t0) / 1000).toFixed(0)} s, cpu ${(cpuNow() / 1000).toFixed(0)} s`);
    save(k + 1);
  }

  // ---- after the windows: quantize as stored, record the open-loop nominal, tune the feedback gains.
  quantize(plan.dq, QUANT.angle);
  plan.ratesOverride = Float64Array.from(plan.rates());
  quantize(plan.ratesOverride, RATE_STEP);
  if (plan.gyroFF) quantize(plan.gyroFF, GYRO_STEP);
  const open = await pool.full({ type: 'full', design, moveId, plan: toData(plan), nominal: null, nominalSamples: 0, feedback: true, perturbs: [], trace: true, recordNominal: true }, key);
  let run0 = open.runs[0];
  let nom = run0.nominal!;
  quantizeNominal(nom);
  log(`nominal: cost ${run0.cost.toFixed(1)}${run0.fell ? ' FELL' : ''}, wall ${run0.wallS.toFixed(2)} s (clip ${move.duration.toFixed(2)} s), ${run0.nominalSamples} samples${run0.honesty ? ` HONESTY: ${run0.honesty}` : ''}`);
  // Gain pass: CMA over the six feedback gains with Δq fixed, whole-move perturbed rollouts.
  const gscen = gainScenarios(spec, spec.kind === 'getup' ? 6 : 8, run0.wallS - 0.5, ses.w.mass, legJoints);
  // The feedback runs in the nominal too, so the nominal (scenario 0, weighted double) is part of the score.
  const gainF = async (fbs: FeedbackGains[]): Promise<number[]> => {
    const res = await Promise.all(fbs.map((fb) => pool.fullMany({
      type: 'full', design, moveId, plan: { ...toData(plan), fb }, nominal: nom, nominalSamples: run0.nominalSamples, feedback: true, perturbs: [{}, ...gscen], trace: false, recordNominal: false,
    }, key)));
    return res.map((r) => {
      const cs = r.runs.map((x) => x.cost);
      return robustF(cs) + cs[0];
    });
  };
  // gyroL stays 0: it reads the simulated nominal, which the nominal rollout is still recording (a tuned
  // gyroL made the hook's replay differ from its recorded nominal, poc3).
  const G = ['ankleD', 'ankleV', 'hipTilt', 'gyroD', 'gyroV'] as const;
  const gHi = new Float64Array([4, 4, 1.5, 4, 4]);
  const toFb = (x: ArrayLike<number>): FeedbackGains => ({ ...DEFAULT_FEEDBACK, ...Object.fromEntries(G.map((g, i) => [g, x[i]])) });
  const g0 = new Float64Array(G.map((g) => DEFAULT_FEEDBACK[g]));
  const [fZero, fDef] = await gainF([toFb(new Float64Array(G.length)), toFb(g0)]);
  let bestFb = fDef <= fZero ? toFb(g0) : toFb(new Float64Array(G.length));
  let bestG = Math.min(fZero, fDef);
  if (o.gainGens > 0) {
    const cma = new SepCMA({ mean: g0, sigma0: new Float64Array(gHi.map((v) => v * 0.2)), lo: new Float64Array(G.length), hi: gHi, lambda: 10, seed: seedOf(`${key}gains`) });
    let stall = 0;
    for (let g = 0; g < o.gainGens && stall < 5; g++) {
      const xs = cma.ask();
      const fs = await gainF(xs.map(toFb));
      cma.tell(xs, fs);
      let imp = false;
      fs.forEach((f, i) => {
        if (f < bestG - 1e-3 * Math.abs(bestG)) {
          bestG = f;
          bestFb = toFb(xs[i]);
          imp = true;
        }
      });
      stall = imp ? 0 : stall + 1;
    }
  }
  log(`gains: no feedback ${fZero.toFixed(1)}, default ${fDef.toFixed(1)}, best ${bestG.toFixed(1)}: ${G.map((g) => `${g} ${bestFb[g].toFixed(2)}`).join(' ')}`);
  if (G.some((g) => bestFb[g] !== plan.fb[g])) {
    // New gains change the nominal: record it again, and keep them only if it still stands.
    const alt = await pool.full({ type: 'full', design, moveId, plan: { ...toData(plan), fb: bestFb }, nominal: null, nominalSamples: 0, feedback: true, perturbs: [], trace: true, recordNominal: true }, key);
    if (!alt.runs[0].fell || run0.fell) {
      plan.fb = bestFb;
      run0 = alt.runs[0];
      nom = run0.nominal!;
      quantizeNominal(nom);
      log(`nominal with tuned gains: cost ${run0.cost.toFixed(1)}${run0.fell ? ' FELL' : ''}, wall ${run0.wallS.toFixed(2)} s`);
    } else log('tuned gains make the nominal fall: kept the defaults');
  }
  // Reproduction: the same stored data must give the same rollout.
  const replay = await pool.full({ type: 'full', design, moveId, plan: toData(plan), nominal: nom, nominalSamples: run0.nominalSamples, feedback: true, perturbs: [], trace: true, recordNominal: false }, key);
  const exact = traceDiff(run0.trace!, replay.runs[0].trace!) === 0;
  log(`replay: ${exact ? 'bit-identical' : `differs by ${(traceDiff(run0.trace!, replay.runs[0].trace!) * 57.3).toFixed(4)}° max`}`);
  plan.nominal = nom;
  plan.nominalSamples = run0.nominalSamples;
  const status = run0.fell ? 'failed' : 'polished';
  return {
    spec, plan, status, reason: run0.fell ? `nominal falls (window ${failedAt ?? '?'})` : undefined, nominal: nom, nominalSamples: run0.nominalSamples, wallS: run0.wallS,
    windowLog, gainLog: { before: fDef, after: bestG, fb: bestFb }, cpuS: cpuNow() / 1000, replayExact: exact,
    trace: run0.trace, traceN: run0.traceN, impactErr: run0.impactErr, impactSpeed: run0.impactSpeed,
  };
}

/** Max |Δq| (joints and root) between two traces, rad (Infinity if the lengths differ). */
export function traceDiff(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const c = i % TRACE_STRIDE;
    if (c >= 3 && c <= 32) m = Math.max(m, Math.abs(a[i] - b[i]));
  }
  return m;
}

/** Dead bands that cover the nominal's own interpolation and quantization error, so its replay gets no feedback. */
export function deadBands(nom: Float64Array, n: number): DeadBands {
  let com = 0, vel = 0, L = 0, tilt = 0;
  for (let i = 1; i < n - 1; i++) {
    const o = i * NOMINAL_STRIDE;
    const d2 = (c: number) => Math.abs(nom[o + c - NOMINAL_STRIDE] - 2 * nom[o + c] + nom[o + c + NOMINAL_STRIDE]) / 8;
    com = Math.max(com, Math.hypot(d2(0), d2(1)));
    vel = Math.max(vel, Math.hypot(d2(3), d2(4)));
    L = Math.max(L, Math.hypot(d2(6), d2(7)));
    tilt = Math.max(tilt, 2 * Math.hypot(d2(10), d2(11)));
  }
  return {
    com: Math.max(DEFAULT_BANDS.com, 1.5 * com + 0.001),
    comVel: Math.max(DEFAULT_BANDS.comVel, 1.5 * vel + 0.002),
    L: Math.max(DEFAULT_BANDS.L, 1.5 * L + 0.02),
    tilt: Math.max(DEFAULT_BANDS.tilt, 1.5 * tilt + 0.002),
  };
}
