// Balance drills (docs/design/balance-engine.md §8): headless, in the minimal world of
// tests/control/helpers.ts with the real physics systems (src/physics/systems), one drill per child
// process, at most --jobs at once. Every drill writes its numbers as JSON; the parent prints a summary
// against the section 8 targets and saves everything under tests/balance/.out/ (git-ignored).
//
//   approach   two fighters of one design, 3-6 m apart across the cage centre, each turned 0, ±15 or
//              ±30° off the line, both on close_distance (no strikes) for 14 s: they walk in and
//              hold. Both are measured.
//   push       a lone fighter shoved at the torso for 0.1 s from 8 directions: standing, mid-swing
//              walking, or just arrived. ΔV rises by 0.1 m/s to the first fall (--quick: 1.1 m/s only).
//   shuffle    at 1.4 m from a standing opponent: a 0.4 m square (forward, back, left, right, each
//              back to the start), then circling each way.
//
// usage:
//   npx tsx tools/balance-drills.ts [--drills approach,push,shuffle] [--designs firecracker,savate,haymaker,pylon]
//                                   [--balance legacy|dcm] [--jobs 2] [--quick] [--label name] [--situations stance]
//   npx tsx tools/balance-drills.ts --job '<json>'        one drill in this process, JSON on stdout
//   --tune BALANCE_TUNING.stanceAnkleKp=1,FOOTWORK_TUNING.walkGapM=0.03   A/B a tuning table value
//   (the drill children set it before they run; the tables are the engine's exported tunables)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimEvent } from '../src/core/protocol';
import type { Vec3 } from '../src/core/types';
import { controllerOf, controlSystem } from '../src/physics/control';
import { CONTROL } from '../src/physics/control/balance/config';
import { COM_REF } from '../src/physics/control/balance/com-ref';
import { FOOTWORK_TUNING } from '../src/physics/control/balance/footsteps';
import { GYRO_POLICY } from '../src/physics/control/balance/gyro-policy';
import { BALANCE_TUNING } from '../src/physics/control/balance/index';
import { INERTIA } from '../src/physics/control/balance/inertialize';
import { STEP_ADJUST } from '../src/physics/control/balance/step-adjust';
import { COUNTER_YAW, YAW_TUNING } from '../src/physics/control/controller';
import type { SimContext, SimSystem } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { BalanceRecorder, type BalanceMetrics } from '../tests/balance/recorder';
import { comPos, intent, isDown, makeSim, type Sim } from '../tests/control/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'tests', 'balance', '.out');
const DEG = Math.PI / 180;
const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const LEAN_S = 0.8; // standing still after release: the recorder measures the standing lean
const APPROACH_S = 14;
const PUSH_S = 0.1;
const PUSH_WATCH_S = 4;
const STABLE_SPEED = 0.3; // m/s and rad/s: Euphoria's "stable"
const STABLE_HOLD_S = 0.2;
const BLOWUP_QVEL = 400;

type Situation = 'stance' | 'walk' | 'arrive';
export type Job =
  | { kind: 'approach'; design: string; dist: number; angle: number; seconds: number; seed: number }
  | { kind: 'push'; design: string; situation: Situation; dir: number; dv: number; seed: number }
  | { kind: 'shuffle'; design: string; seed: number };

export interface ApproachOut { kind: 'approach'; job: Job; robots: BalanceMetrics[]; controlUs: number; blowup: boolean }
export interface PushOut { kind: 'push'; job: Job; survived: boolean; steps: number; stableAfter: number; satPeak: number; applied: boolean }
export interface ShuffleOut { kind: 'shuffle'; job: Job; metrics: BalanceMetrics; legs: Array<{ leg: string; arrived: number; steps: number }>; controlUs: number; blowup: boolean }
export type DrillOut = ApproachOut | PushOut | ShuffleOut;

// ------------------------------------------------------------------ one drill (child process)

/** The control system timed (µs per robot per physics step). */
function timedSystems(): { systems: SimSystem[]; us: () => number } {
  let ms = 0, steps = 0;
  const timed: SimSystem = {
    ...controlSystem,
    pre(c) {
      const t0 = performance.now();
      controlSystem.pre!(c);
      ms += performance.now() - t0;
      steps++;
    },
  };
  return { systems: SYSTEMS.map((s) => (s === controlSystem ? timed : s)), us: () => (ms * 1000) / Math.max(1, steps) / 2 };
}

function blownUp(ctx: SimContext): boolean {
  const v = ctx.data.qvel as Float64Array;
  for (let k = 0; k < ctx.model.nv; k++) if (!(Math.abs(v[k]) < BLOWUP_QVEL)) return true;
  return false;
}

/** Step the sim `s` seconds, sampling the recorders and clearing events; false on a blow-up. */
function run(sim: Sim, s: number, recorders: BalanceRecorder[], each?: (ctx: SimContext) => void): boolean {
  const { ctx } = sim;
  const n = Math.round(s / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    for (const r of recorders) r.sample(ctx);
    each?.(ctx);
    ctx.events.length = 0;
    if (i % 50 === 0 && blownUp(ctx)) return false;
  }
  return true;
}

async function approach(job: Extract<Job, { kind: 'approach' }>): Promise<ApproachOut> {
  const a = job.angle * DEG;
  const t = timedSystems();
  // Centred on the cage (its limit is 3.35 m from the centre: goals and landings stay inside it).
  const h = job.dist / 2;
  const sim = await makeSim({ design: job.design, x: -h, y: 0, yaw: a }, { design: job.design, x: h, y: 0, yaw: Math.PI + a }, { seed: job.seed, systems: t.systems });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  const recs = [new BalanceRecorder(sim.ctx, 0, LEAN_S), new BalanceRecorder(sim.ctx, 1, LEAN_S)];
  let ok = run(sim, LEAN_S, recs);
  for (const r of sim.ctx.robots) r.intent = intent('close_distance', 'head', 0.5);
  if (ok) ok = run(sim, job.seconds, recs);
  const out: ApproachOut = { kind: 'approach', job, robots: recs.map((r) => r.result()), controlUs: t.us(), blowup: !ok };
  sim.dispose();
  return out;
}

async function lone(design: string, seed: number, systems: readonly SimSystem[]): Promise<Sim> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { seed, systems });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  sim.seconds(0.5);
  sim.release(0);
  return sim;
}

async function pushTrial(job: Extract<Job, { kind: 'push' }>): Promise<PushOut> {
  const sim = await lone(job.design, job.seed, SYSTEMS);
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  sim.seconds(1.2);
  const z0 = comPos(ctx, r)[2];
  let applied = true;
  if (job.situation !== 'stance') {
    // Walk 3 m ahead (push mid-swing), or 1 m ahead (push on arrival).
    const f = c.gait.currentFrame();
    const far = job.situation === 'walk' ? 3 : 1;
    c.goal = { x: f.x + Math.cos(f.heading) * far, y: f.y + Math.sin(f.heading) * far, heading: f.heading };
    applied = false;
    const n = Math.round(12 / ctx.dt);
    for (let i = 0; i < n && !applied; i++) {
      sim.step();
      ctx.events.length = 0;
      if (job.situation === 'walk') {
        const side = c.gait.swingSide;
        const sw = side ? c.gait.feet[side] : null;
        // (The balance engine flies its own swings: their progress is the engine's.)
        const e = c.engine;
        const progress = e ? (e.swing.active ? e.swing.progress(ctx.time) : 0) : sw ? sw.t / sw.dur : 0;
        if (c.gait.phase === 'single' && sw && sw.phase === 'swing' && progress >= 0.4 && ctx.time > 2.5) applied = true;
      } else if (c.gait.bothPlanted()) {
        const g = c.goal!, cur = c.gait.currentFrame();
        if (Math.hypot(cur.x - g.x, cur.y - g.y) < 0.12) applied = true;
      }
      if (isDown(ctx, r, z0) || r.down) break;
    }
    if (!applied) {
      sim.dispose();
      return { kind: 'push', job, survived: false, steps: 0, stableAfter: Infinity, satPeak: 0, applied: false };
    }
  }
  const heading = c.gait.bothPlanted() ? c.gait.currentFrame().heading : c.lastSense!.heading - c.stance.pelvisYaw;
  const dirW = heading + job.dir * DEG;
  const f = (job.dv * c.mass) / PUSH_S;
  const force: Vec3 = [Math.cos(dirW) * f, Math.sin(dirW) * f, 0];
  const touch0 = c.probe.touchdowns;
  const body = r.parts.get('torso')!.body;
  const xf = ctx.data.xfrc_applied as Float64Array;
  let fell = false, satPeak = 0;
  const watch = (): void => {
    for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === 0) fell = true;
    ctx.events.length = 0;
    if (isDown(ctx, r, z0)) fell = true;
    satPeak = Math.max(satPeak, c.gyro?.saturation ?? 0);
  };
  for (let i = 0; i < Math.round(PUSH_S / ctx.dt); i++) {
    xf[body * 6] += force[0];
    xf[body * 6 + 1] += force[1];
    sim.step();
    xf[body * 6] -= force[0];
    xf[body * 6 + 1] -= force[1];
    watch();
  }
  if (job.situation !== 'stance') c.goal = null;
  const pushedAt = ctx.time;
  let stableSince = -1, stableAfter = Infinity;
  const n = Math.round(PUSH_WATCH_S / ctx.dt);
  const cv = ctx.data.cvel as Float64Array;
  for (let i = 0; i < n && !fell; i++) {
    sim.step();
    watch();
    const s = c.lastSense;
    if (!s || Number.isFinite(stableAfter)) continue;
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    const rate = Math.hypot(cv[body * 6], cv[body * 6 + 1]);
    const stable = speed < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted() && !r.down;
    if (!stable) stableSince = -1;
    else if (stableSince < 0) stableSince = ctx.time;
    else if (ctx.time - stableSince >= STABLE_HOLD_S && !Number.isFinite(stableAfter)) stableAfter = stableSince - pushedAt;
  }
  const out: PushOut = { kind: 'push', job, survived: !fell, steps: c.probe.touchdowns - touch0, stableAfter, satPeak, applied: true };
  sim.dispose();
  return out;
}

async function shuffle(job: Extract<Job, { kind: 'shuffle' }>): Promise<ShuffleOut> {
  const t = timedSystems();
  const sim = await makeSim({ design: job.design, x: 0, y: 0, yaw: 0 }, { design: job.design, x: 1.4, y: 0, yaw: Math.PI }, { seed: job.seed, systems: t.systems });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  const { ctx } = sim;
  const c = controllerOf(ctx.robots[0])!;
  const rec = new BalanceRecorder(ctx, 0, LEAN_S);
  let ok = run(sim, LEAN_S, [rec]);
  const opp = (): Vec3 => comPos(ctx, ctx.robots[1]);
  const home = c.gait.currentFrame();
  const legs: ShuffleOut['legs'] = [];
  const offsets: Array<[string, number, number]> = [
    ['forward', 0.4, 0], ['home', 0, 0], ['back', -0.4, 0], ['home', 0, 0],
    ['left', 0, 0.4], ['home', 0, 0], ['right', 0, -0.4], ['home', 0, 0],
  ];
  let goal: { x: number; y: number } | null = null;
  rec.goal = () => goal;
  for (const [leg, fx, fy] of offsets) {
    if (!ok) break;
    const x = home.x + fx, y = home.y + fy;
    const o = opp();
    goal = { x, y };
    c.goal = { x, y, heading: Math.atan2(o[1] - y, o[0] - x) };
    const t0 = ctx.time, s0 = c.probe.touchdowns;
    let arrived = Infinity;
    ok = run(sim, 2.5, [rec], () => {
      if (Number.isFinite(arrived) || !c.gait.bothPlanted()) return;
      const f = c.gait.currentFrame();
      if (Math.hypot(f.x - x, f.y - y) < 0.1) arrived = ctx.time - t0;
    });
    legs.push({ leg, arrived, steps: c.probe.touchdowns - s0 });
  }
  goal = null;
  for (const tactic of ['circle_left', 'circle_right'] as const) {
    if (!ok) break;
    ctx.robots[0].intent = intent(tactic, 'head', 0.5);
    const s0 = c.probe.touchdowns;
    ok = run(sim, 4, [rec]);
    legs.push({ leg: tactic, arrived: NaN, steps: c.probe.touchdowns - s0 });
  }
  const out: ShuffleOut = { kind: 'shuffle', job, metrics: rec.result(), legs, controlUs: t.us(), blowup: !ok };
  sim.dispose();
  return out;
}

const TABLES: Record<string, Record<string, unknown>> = { BALANCE_TUNING, FOOTWORK_TUNING, STEP_ADJUST, COM_REF, GYRO_POLICY, INERTIA, COUNTER_YAW, YAW_TUNING };

/** SD_TUNE='TABLE.key=value,...': set numeric tunables before a drill (A/B runs). */
function applyTune(spec: string | undefined): void {
  if (!spec) return;
  for (const item of spec.split(',')) {
    const [path, raw] = item.split('=');
    const [table, key] = path.split('.');
    const t = TABLES[table];
    const v = Number(raw);
    if (!t || !(key in t) || typeof t[key] !== 'number' || !Number.isFinite(v)) throw new Error(`--tune: unknown or non-numeric ${item}`);
    t[key] = v;
  }
}

export async function runJob(job: Job): Promise<DrillOut> {
  applyTune(process.env.SD_TUNE);
  switch (job.kind) {
    case 'approach': return approach(job);
    case 'push': return pushTrial(job);
    case 'shuffle': return shuffle(job);
  }
}

// ------------------------------------------------------------------ the parent: jobs, ladders, summary

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runChild(job: Job, balance: string): Promise<DrillOut> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, '--job', JSON.stringify(job)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, SD_BALANCE: balance, SD_TUNE: arg('tune', '') },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`${JSON.stringify(job)} exited ${code}`));
      else resolve(JSON.parse(line) as DrillOut);
    });
  });
}

/** A queue of tasks run at most `jobs` at a time; a task may queue more (push ladders). */
async function pool(tasks: Array<() => Promise<void>>, jobs: number): Promise<void> {
  const worker = async () => {
    for (let t = tasks.shift(); t; t = tasks.shift()) await t();
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : String(x));
const ok = (pass: boolean) => (pass ? 'PASS' : 'FAIL');

export function summarizeApproach(outs: ApproachOut[], design: string): string[] {
  const rs = outs.filter((o) => o.job.design === design).flatMap((o) => o.robots.map((m) => ({ m, job: o.job as Extract<Job, { kind: 'approach' }>, o })));
  if (!rs.length) return [];
  const falls = rs.filter(({ m }) => m.falls.length > 0);
  const closing = rs.filter(({ m }) => m.closingSeconds > 0.5).map(({ m }) => m.closingSpeed);
  const four = rs.filter(({ job }) => job.dist === 4).map(({ m }) => m.timeTo13);
  const minSpeed = design === 'firecracker' ? 0.55 : 0.6;
  const cs = mean(closing), t4 = maxOf(four);
  const single = mean(rs.map(({ m }) => m.singleInside2));
  const after = rs.map(({ m }) => m.stepsAfterArrive).sort((a, b) => a - b);
  const low = mean(rs.map(({ m }) => m.torsoRateLow)), high = mean(rs.map(({ m }) => m.torsoRateHigh));
  const tilt = rs.map(({ m }) => m.tiltPeakDeg);
  const pstd = mean(rs.map(({ m }) => m.pelvisStdCm));
  const jump = rs.map(({ m }) => m.copJumpCm);
  const dcm = mean(rs.map(({ m }) => m.dcmErrCm));
  const lim = mean(rs.map(({ m }) => m.servoLimitShare));
  const sat = mean(rs.map(({ m }) => m.gyroSatFootwork));
  const res = mean(rs.map(({ m }) => m.reserveAtTouchdown));
  const us = mean(outs.filter((o) => o.job.design === design).map((o) => o.controlUs));
  return [
    `  approach-and-hold ${rs.length} fighter-drills (${outs.filter((o) => o.blowup).length} blow-ups)`,
    `    falls                          ${falls.length}${falls.length ? ` (${falls.map(({ job, m }) => `${job.dist}m/${job.angle}°@${f1(m.falls[0].t)}s ${m.falls[0].activity}`).join(', ')})` : ''}   target 0   ${ok(falls.length === 0)}`,
    `    closing speed beyond 1.3 m     ${f2(cs)} m/s   target >= ${minSpeed}   ${ok(cs >= minSpeed)}`,
    `    4 m to 1.3 m (worst)           ${f1(t4)} s (each ${four.map(f1).join(' ')})   target <= 3.5   ${ok(t4 <= 3.5)}`,
    `    single support inside 2 m      ${pct(single)}   target <= 50%   ${ok(single <= 0.5)}`,
    `    steps after arriving           median ${after[Math.floor(after.length / 2)]}, max ${after[after.length - 1]}   target <= 2`,
    `    torso rate below / above 3 Hz  ${f2(low)} / ${f2(high)} rad/s RMS   target <= 0.30 / 0.25   ${ok(low <= 0.3 && high <= 0.25)}`,
    `    tilt peak beyond stance lean   mean ${f1(mean(tilt))}°, worst ${f1(maxOf(tilt))}° (lean ${f1(mean(rs.map(({ m }) => m.standingLeanDeg)))}°)   target <= 6   ${ok(maxOf(tilt) <= 6)}`,
    `    pelvis height std              ${f2(pstd)} cm   target <= 1.5   ${ok(pstd <= 1.5)}`,
    `    planned-COP jump per tick      worst ${f1(maxOf(jump))} cm, mean worst ${f1(mean(jump))} cm, p99 ${f1(mean(rs.map(({ m }) => m.copJumpP99Cm)))} cm   target <= 2   ${ok(maxOf(jump) <= 2)}`,
    `    DCM error RMS                  ${f1(dcm)} cm   target <= 2   ${ok(dcm <= 2)}`,
    `    planted-leg servo at limit     ${pct(lim)}   target <= 3%   ${ok(lim <= 0.03)}`,
    `    gyro saturation in footwork    ${f2(sat)} (peak ${f2(maxOf(rs.map(({ m }) => m.gyroSatPeak)))})   target <= 0.10   ${ok(sat <= 0.1)}`,
    `    reserve at touchdown           mean ${f2(res)}, min ${f2(Math.min(...rs.map(({ m }) => m.reserveAtTouchdownMin)))}   target >= 0.6   ${ok(res >= 0.6)}`,
    `    control cost                   ${f1(us)} µs per robot per step   target < 40   ${ok(us < 40)}`,
  ];
}

export function summarizePush(outs: PushOut[], design: string, situation: Situation): string[] {
  const rs = outs.filter((o) => o.job.design === design && (o.job as Extract<Job, { kind: 'push' }>).situation === situation);
  if (!rs.length) return [];
  const dirs = [...new Set(rs.map((o) => (o.job as Extract<Job, { kind: 'push' }>).dir))].sort((a, b) => a - b);
  const cells = dirs.map((d) => {
    const list = rs.filter((o) => (o.job as Extract<Job, { kind: 'push' }>).dir === d);
    const survived = list.filter((o) => o.survived).map((o) => (o.job as Extract<Job, { kind: 'push' }>).dv);
    const best = survived.length ? Math.max(...survived) : 0;
    return { d, best, steps: list.filter((o) => o.survived).map((o) => o.steps), stable: list.filter((o) => o.survived).map((o) => o.stableAfter) };
  });
  const n11 = cells.filter((c) => c.best >= 1.1 - 1e-6).length;
  const steps = cells.flatMap((c) => c.steps).sort((a, b) => a - b);
  const stable = cells.flatMap((c) => c.stable).filter(Number.isFinite).sort((a, b) => a - b);
  return [
    `  push (${situation}): max ΔV survived by direction ${cells.map((c) => `${c.d}°:${f1(c.best)}`).join(' ')} m/s; 1.1 m/s survived ${n11}/${cells.length}` +
      `; steps median ${steps[Math.floor(steps.length / 2)] ?? '-'}; stable after median ${f2(stable[Math.floor(stable.length / 2)] ?? NaN)} s${rs.some((o) => !o.applied) ? ` (${rs.filter((o) => !o.applied).length} not applied)` : ''}`,
  ];
}

export function summarizeShuffle(outs: ShuffleOut[], design: string): string[] {
  const o = outs.find((x) => x.job.design === design);
  if (!o) return [];
  const m = o.metrics;
  return [
    `  shuffle: falls ${m.falls.length}${m.falls.length ? ` (${m.falls.map((x) => `${f1(x.t)}s ${x.activity}`).join(', ')})` : ''}, legs ${o.legs.map((l) => `${l.leg} ${Number.isFinite(l.arrived) ? f1(l.arrived) + 's' : l.leg.startsWith('circle') ? '' : 'never'}/${l.steps}st`).join(', ')}`,
    `    single support ${pct(m.singleInside2)}, torso rate ${f2(m.torsoRateLow)}/${f2(m.torsoRateHigh)}, tilt ${f1(m.tiltPeakDeg)}°, COP jump ${f1(m.copJumpCm)} cm, DCM err ${f1(m.dcmErrCm)} cm, servo at limit ${pct(m.servoLimitShare)}, gyro ${f2(m.gyroSatFootwork)}, control ${f1(o.controlUs)} µs${o.blowup ? ', BLOW-UP' : ''}`,
  ];
}

async function main(): Promise<void> {
  const ji = process.argv.indexOf('--job');
  if (ji >= 0) {
    const out = await runJob(JSON.parse(process.argv[ji + 1]) as Job);
    console.log(JSON.stringify(out));
    return;
  }
  const drills = arg('drills', 'approach,push,shuffle').split(',');
  const designs = arg('designs', MODERN.join(',')).split(',');
  const balance = arg('balance', CONTROL.balance);
  const jobs = Math.min(2, Math.max(1, Number(arg('jobs', '2'))));
  const quick = process.argv.includes('--quick');
  const label = arg('label', quick ? 'quick' : 'full');
  const situations = arg('situations', 'stance,walk').split(',') as Situation[];
  const seed = Number(arg('seed', '1'));
  const results: DrillOut[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const t0 = performance.now();
  const add = (job: Job, then?: (o: DrillOut) => void) => tasks.push(async () => {
    const o = await runChild(job, balance);
    results.push(o);
    then?.(o);
  });
  for (const design of designs) {
    if (drills.includes('approach')) {
      const dists = quick ? [4] : [3, 4, 5, 6];
      const angles = quick ? [0, 30] : [0, 15, -15, 30, -30];
      for (const dist of dists) for (const angle of angles) add({ kind: 'approach', design, dist, angle, seconds: APPROACH_S, seed });
    }
    if (drills.includes('shuffle')) add({ kind: 'shuffle', design, seed });
    if (drills.includes('push')) {
      for (const situation of situations) {
        for (let dir = 0; dir < 360; dir += 45) {
          // A ladder: 0.6 m/s up by 0.1 to the first fall (quick: 1.1 only).
          const ladder = (dv: number): void => add({ kind: 'push', design, situation, dir, dv, seed }, (o) => {
            const p = o as PushOut;
            if (!quick && p.survived && p.applied && dv < 2.45) {
              ladder(Math.round((dv + 0.1) * 10) / 10);
            }
          });
          ladder(quick ? 1.1 : 0.6);
        }
      }
    }
  }
  await pool(tasks, jobs);
  const tune = arg('tune', '');
  const lines: string[] = [`balance drills (${balance}, ${label}${tune ? `, tune ${tune}` : ''}), wall ${((performance.now() - t0) / 1000).toFixed(0)} s`];
  for (const design of designs) {
    lines.push(`${design}:`);
    lines.push(...summarizeApproach(results.filter((o): o is ApproachOut => o.kind === 'approach'), design));
    lines.push(...summarizeShuffle(results.filter((o): o is ShuffleOut => o.kind === 'shuffle'), design));
    for (const situation of situations) lines.push(...summarizePush(results.filter((o): o is PushOut => o.kind === 'push'), design, situation));
  }
  console.log(lines.join('\n'));
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${label}-${balance}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ balance, label, drills, designs, results, summary: lines }, null, 1));
  console.log(`saved ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
