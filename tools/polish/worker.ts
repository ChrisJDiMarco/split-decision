// A polish worker process: holds rollout worlds and evaluates candidates, commits windows and runs
// whole moves on request from the master (run.ts). Headless, one task at a time.
import { NOMINAL_STRIDE } from '../../src/robots/motions/polish/format';
import type { PolishPlan } from '../../src/robots/motions/polish/player';
import { PlanState, splineJerkCost, writeVars } from './plan';
import type { CommitReply, EvalReply, FullReply, PlanData, Reply, Task, WindowCtx } from './protocol';
import { CostAcc, newTrace, TRACE_STRIDE, type Perturb } from './rollout';
import { MoveSession, type StartPoint } from './session';
import { honestyViolation } from './world';

export const NOMINAL_CAP = 6000; // samples (24 s of wall time at 250 Hz)
export const JERK_WEIGHT = 2;
/** Tempo: playing slower than today costs (the goal is faster than human); any warp costs a little. */
export function tempoCost(p: PlanState): number {
  let s = 0;
  const clipKnots = Math.min(p.warp.length, Math.ceil(p.spec.move.duration / 0.1) + 1);
  for (let i = 0; i < clipKnots; i++) {
    const w = p.warp[i];
    s += 8 * (Math.min(0, w) / 0.3) ** 2 + (w / 0.3) ** 2;
  }
  return clipKnots ? s / clipKnots : 0;
}

const sessions = new Map<string, Promise<MoveSession>>();
export function sessionFor(design: string, moveId: string, full = false): Promise<MoveSession> {
  const k = `${design}/${moveId}/${full ? 'full' : 'one'}`;
  let s = sessions.get(k);
  if (!s) {
    s = MoveSession.create(design, moveId, full);
    sessions.set(k, s);
  }
  return s;
}

const ctxCache = new Map<string, WindowCtx>();
function rememberCtx(c: WindowCtx): void {
  ctxCache.set(c.key, c);
  if (ctxCache.size > 24) ctxCache.delete(ctxCache.keys().next().value!);
}

export function loadPlan(ses: MoveSession, d: PlanData): PlanState {
  const p = new PlanState(ses.spec);
  p.dq.set(d.dq);
  p.warp.set(d.warp);
  if (p.gyroFF && d.gyroFF) p.gyroFF.set(d.gyroFF);
  p.fb = { ...d.fb };
  p.deadband = { ...d.deadband };
  p.ratesOverride = d.rates ? Float64Array.from(d.rates) : null;
  p.track = ses.track;
  return p;
}

function maxWall(c: WindowCtx, start: StartPoint): number {
  return Math.max(0.5, (c.untilTau - start.clock.tau) / 0.25 + 0.5);
}

function startOf(ses: MoveSession, c: WindowCtx, plan: PolishPlan): StartPoint {
  if (c.from.kind === 'placed') return ses.settle(plan);
  return { snap: c.from.snap, clock: c.from.clock };
}

async function evalTask(c: WindowCtx, cands: Float64Array[], robust: boolean): Promise<EvalReply> {
  const ses = await sessionFor(c.design, c.moveId);
  const plan = loadPlan(ses, c.base);
  const costs: number[][] = [];
  const fell: boolean[][] = [];
  const nom = new Float64Array(NOMINAL_CAP * NOMINAL_STRIDE);
  for (const x of cands) {
    writeVars(plan, c.vars, x);
    if (c.nominal) nom.set(c.nominal.subarray(0, Math.min(c.nominal.length, nom.length)));
    else nom.fill(0);
    const pp = plan.toPlan(nom, NOMINAL_CAP);
    const start = startOf(ses, c, pp);
    const jerk = JERK_WEIGHT * splineJerkCost(plan) + tempoCost(plan);
    const cc: number[] = [];
    const ff: boolean[] = [];
    const n = robust ? c.scenarios.length : 1;
    for (let s = 0; s < n; s++) {
      const acc = new CostAcc(ses.ref, c.fromTau, c.lookaheadTau, c.endTau, ses.spec.nLib, c.poseScale);
      ses.roll(start, pp, {
        untilTau: c.untilTau, maxWallS: maxWall(c, start), feedback: true, cost: acc, nominal: s === 0 ? nom : null,
        stopOnFall: true, perturb: s > 0 ? c.scenarios[s] : undefined,
      });
      const r = acc.result();
      cc.push(r.total + jerk);
      ff.push(r.fell);
    }
    costs.push(cc);
    fell.push(ff);
  }
  return { costs, fell };
}

async function commitTask(c: WindowCtx, x: Float64Array, snapAtTau: number | null, wantTrace: boolean): Promise<CommitReply> {
  const ses = await sessionFor(c.design, c.moveId);
  const plan = loadPlan(ses, c.base);
  writeVars(plan, c.vars, x);
  const nom = new Float64Array(NOMINAL_CAP * NOMINAL_STRIDE);
  if (c.nominal) nom.set(c.nominal.subarray(0, Math.min(c.nominal.length, nom.length)));
  const pp = plan.toPlan(nom, NOMINAL_CAP);
  const start = startOf(ses, c, pp);
  const acc = new CostAcc(ses.ref, c.fromTau, c.lookaheadTau, c.endTau, ses.spec.nLib, c.poseScale);
  const trace = wantTrace ? newTrace() : null;
  const res = ses.roll(start, pp, { untilTau: c.untilTau, maxWallS: maxWall(c, start), feedback: true, cost: acc, nominal: nom, snapAtTau, trace, stopOnFall: false });
  const r = acc.result();
  let tr: Float64Array | null = null;
  if (trace) {
    const nl = ses.spec.nLib;
    tr = new Float64Array(trace.n * (1 + nl));
    for (let i = 0; i < trace.n; i++) {
      const o = i * TRACE_STRIDE;
      tr[i * (1 + nl)] = trace.data[o + 1];
      ses.w.joints.forEach((j, ri) => {
        if (j.lib >= 0) tr![i * (1 + nl) + 1 + j.lib] = trace.data[o + 10 + ri];
      });
    }
  }
  return {
    cost: r.total + JERK_WEIGHT * splineJerkCost(plan) + tempoCost(plan), terms: { ...r.terms, impact: r.impact, terminal: r.terminal, jerk: JERK_WEIGHT * splineJerkCost(plan), tempo: tempoCost(plan) }, fell: r.fell,
    snap: res.snap, clock: res.snapPlayer, nominal: nom, trace: tr, traceN: trace?.n ?? 0,
  };
}

async function fullTask(t: Extract<Task, { type: 'full' }>): Promise<FullReply> {
  const ses = await sessionFor(t.design, t.moveId, !!t.fullWorld);
  const plan = loadPlan(ses, t.plan);
  const endTau = ses.spec.move.duration + 0.5;
  const runs: FullReply['runs'] = [];
  const perturbs: Array<Perturb | undefined> = t.perturbs.length ? t.perturbs : [undefined];
  for (const p of perturbs) {
    const nom = t.recordNominal ? new Float64Array(NOMINAL_CAP * NOMINAL_STRIDE) : t.nominal;
    const pp = plan.toPlan(nom, t.recordNominal ? NOMINAL_CAP : t.nominalSamples);
    const start = ses.settle(pp);
    const acc = new CostAcc(ses.ref, t.costFrom ?? 0, endTau, endTau, ses.spec.nLib, ses.spec.kind === 'getup' ? 3 / 8 : 1);
    const trace = t.trace ? newTrace() : null;
    let honesty: string | null = null;
    const res = ses.roll(start, pp, {
      untilTau: endTau, maxWallS: endTau / 0.25 + 1, feedback: t.feedback, cost: acc, nominal: t.recordNominal ? nom : null, trace,
      perturb: p, stopOnFall: false,
      onTick: p?.push ? undefined : () => {
        if (!honesty) honesty = honestyViolation(ses.w);
      },
    });
    const r = acc.result();
    let samples = 0;
    if (t.recordNominal && nom) samples = Math.min(NOMINAL_CAP, Math.floor(res.wallS * 250) + 1);
    runs.push({
      cost: r.total, terms: { ...r.terms, impact: r.impact, terminal: r.terminal }, fell: r.fell, fellTau: r.fellTau,
      impactErr: r.impactErr, impactSpeed: r.impactSpeed, wallS: res.wallS,
      trace: trace ? trace.data.slice(0, trace.n * TRACE_STRIDE) : null, traceN: trace?.n ?? 0,
      nominal: t.recordNominal && nom ? nom.slice(0, samples * NOMINAL_STRIDE) : null, nominalSamples: samples, honesty,
    });
  }
  return { runs };
}

async function handle(t: Task): Promise<Reply> {
  const c0 = process.cpuUsage();
  try {
    let data: EvalReply | CommitReply | FullReply;
    if (t.type === 'full') data = await fullTask(t);
    else {
      if (t.ctx) rememberCtx(t.ctx);
      const c = ctxCache.get(t.ctxKey);
      if (!c) throw new Error(`unknown window ${t.ctxKey}`);
      data = t.type === 'eval' ? await evalTask(c, t.cands, t.robust) : await commitTask(c, t.x, t.snapAtTau, t.trace);
    }
    const u = process.cpuUsage(c0);
    return { ok: true, cpuMs: (u.user + u.system) / 1000, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) };
  }
}

if (process.send) {
  process.on('message', (m: { id: number; task: Task }) => {
    void handle(m.task).then((reply) => process.send!({ id: m.id, reply }));
  });
  process.on('disconnect', () => process.exit(0));
}
