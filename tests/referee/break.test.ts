// Referee break in the real physics: a fighter shoved over gets room to get up. The standing one
// (driven by a player intent, the rule sits downstream of every intent source) throws nothing new,
// backs off facing him, and FIGHT follows once the downed fighter has been fully up GRACE_S and the
// standing one has his neutral distance. The events go out in telemetry.
// Plus the tactics hook on its own: a windup is pulled, a committed blow finishes.
import { describe, expect, it } from 'vitest';
import loadMujoco from '@mujoco/mujoco';
import type { Intent } from '../../src/core/protocol';
import type { MatchSetup } from '../../src/core/types';
import { controllerOf, SKILLS, sparringIntent } from '../../src/physics/control';
import { buildContext } from '../../src/physics/runtime';
import type { SimContext } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
import type { RefereeLogEvent } from '../../src/core/protocol';
import { GRACE_S, NEUTRAL_M, ROOM_TOL_M, newRefereeState } from '../../src/physics/systems/referee';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';
import { makeSim } from '../control/helpers';

const mj = await loadMujoco();
const SHOVE_DV = 1.6; // m/s of COM velocity, sideways across the line between them
const SHOVE_S = 0.1;
const ENGAGED_M = 1.1;

const player = (tactic: Intent['tactic']): Intent => ({ tactic, target: 'head', aggression: 1, confidence: 1, source: 'player', move: { forward: 1, strafe: 0 } });
const guard: Intent = { tactic: 'guard', target: 'head', aggression: 0.3, confidence: 1, source: 'fallback' };

interface Run {
  ctx: SimContext;
  fallAt: number;
  distAtFall: number;
  distAtFight: number;
  upAt: number; // the downed fighter fully up (off the canvas and done rising)
  startsInBreak: number;
  standingFell: boolean;
  intentKept: boolean;
  sawNeutralTelemetry: boolean;
  published: RefereeLogEvent[]; // referee events as red's telemetry carried them
  qposSig: string;
}

/**
 * Sparring until they are close, then blue is shoved over; from the fall on red is a player asking
 * for an all-out cross and blue guards.
 */
function shovedOver(red: string, blue: string, seconds: number): Run {
  const setup: MatchSetup = {
    fighters: [{ design: red, skin: 'factory', plan: '', temperament: 1 }, { design: blue, skin: 'neon', plan: '', temperament: 1 }],
    seed: 3, timestep: 0.001, reactionDelayS: 0,
  };
  const ctx = buildContext(mj, compileWorld(setup), setup);
  for (const s of SYSTEMS) s.init?.(ctx);
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  const [a, b] = ctx.robots;
  const ca = controllerOf(a)!, cb = controllerOf(b)!;
  const cross = player('cross');
  const com = (r: typeof a) => [ctx.data.subtree_com[r.rootBody * 3], ctx.data.subtree_com[r.rootBody * 3 + 1]];
  const dist = () => { const p = com(a), q = com(b); return Math.hypot(q[0] - p[0], q[1] - p[1]); };
  const torso = b.parts.get('torso')!.body;
  const xf = ctx.data.xfrc_applied as Float64Array;
  const out: Run = { ctx, fallAt: -1, distAtFall: 0, distAtFight: 0, upAt: -1, startsInBreak: 0, standingFell: false, intentKept: true, sawNeutralTelemetry: false, published: [], qposSig: '' };
  let shoveFrom = -1;
  let lastRun = ca.skills.run;
  for (let i = 0; i < seconds / ctx.dt; i++) {
    if (out.fallAt < 0 && i % 500 === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
    if (shoveFrom < 0 && ctx.time > 1 && (dist() < ENGAGED_M || ctx.time > 14)) shoveFrom = i;
    const into = i - shoveFrom;
    let fx = 0, fy = 0;
    if (shoveFrom >= 0 && out.fallAt < 0 && into % 2000 < SHOVE_S / ctx.dt) {
      const p = com(a), q = com(b), d = Math.max(1e-6, dist());
      const f = (SHOVE_DV * (1 + 0.5 * Math.floor(into / 2000)) * cb.mass) / SHOVE_S;
      fx = (-(q[1] - p[1]) / d) * f;
      fy = ((q[0] - p[0]) / d) * f;
      xf[torso * 6] += fx;
      xf[torso * 6 + 1] += fy;
    }
    for (const s of SYSTEMS) s.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    xf[torso * 6] -= fx;
    xf[torso * 6 + 1] -= fy;
    ctx.tick++;
    ctx.time += ctx.dt;
    for (const s of SYSTEMS) s.post?.(ctx);
    for (const e of ctx.events) {
      if (e.kind === 'fall' && e.corner === 1 && out.fallAt < 0) {
        out.fallAt = ctx.time;
        out.distAtFall = dist();
        a.intent = cross;
        b.intent = guard;
      }
      if (e.kind === 'fall' && e.corner === 0 && out.fallAt >= 0 && ctx.referee!.active) out.standingFell = true;
    }
    ctx.events.length = 0;
    const st = ctx.referee!;
    const run = ca.skills.run;
    // A new skill run on red while the break is on and it has been on for more than a control tick.
    if (run && run !== lastRun && st.active && ctx.time - st.since > 0.003) out.startsInBreak++;
    lastRun = run;
    if (out.fallAt >= 0 && out.upAt < 0 && !b.down && !cb.getUp.active && !cb.rising) out.upAt = ctx.time;
    if (st.active && out.fallAt >= 0 && a.intent !== cross) out.intentKept = false;
    if (i % 33 === 0) {
      const t = buildTelemetry(ctx, a, SYSTEMS);
      out.published.push(...(t.referee?.events ?? []));
      if (t.referee?.break && t.referee.role === 'neutral' && t.referee.neutral && t.intent === cross) out.sawNeutralTelemetry = true;
    }
    if (out.fallAt >= 0 && !out.distAtFight && st.log.some((e) => e.kind === 'fight')) out.distAtFight = dist();
  }
  out.qposSig = Array.from(ctx.data.qpos as Float64Array).map((v) => v.toFixed(9)).join(',');
  return out;
}

describe('referee break', () => {
  it('gives a shoved-over fighter room to get up, then restarts the fight', () => {
    const run = shovedOver('savate', 'haymaker', 30);
    const log = run.ctx.referee!.log;
    console.log(`fall ${run.fallAt.toFixed(2)} s at ${run.distAtFall.toFixed(2)} m, up ${run.upAt.toFixed(2)} s, ` +
      `log ${log.map((e) => `${e.kind}@${e.time.toFixed(2)}`).join(' ')}, dist at FIGHT ${run.distAtFight.toFixed(2)} m`);
    expect(run.fallAt).toBeGreaterThan(0);
    const brk = log.find((e) => e.kind === 'break');
    expect(brk).toBeDefined();
    expect(brk!.time - run.fallAt).toBeLessThan(0.003);
    const fight = log.find((e) => e.kind === 'fight');
    expect(fight).toBeDefined();
    expect(run.upAt).toBeGreaterThan(0);
    expect(fight!.time - run.upAt).toBeGreaterThanOrEqual(GRACE_S - 0.002); // the referee reads the state one tick later
    expect(fight).toMatchObject({ reason: 'room' });
    expect(run.distAtFight).toBeGreaterThanOrEqual(NEUTRAL_M - ROOM_TOL_M - 0.01); // he got his neutral distance first
    expect(run.startsInBreak).toBe(0); // an all-out player cross, and not one blow started
    expect(run.intentKept).toBe(true); // the brain's / player's intent is left as it was
    expect(run.sawNeutralTelemetry).toBe(true);
    expect(run.standingFell).toBe(false);
    expect(run.published.filter((e) => e.time <= fight!.time)).toEqual(log.filter((e) => e.time <= fight!.time)); // published once, in order
  }, 120_000);

  it('is deterministic', () => {
    const a = shovedOver('firecracker', 'pylon', 14);
    const b = shovedOver('firecracker', 'pylon', 14);
    expect(a.ctx.referee!.log).toEqual(b.ctx.referee!.log);
    expect(a.qposSig).toBe(b.qposSig);
  }, 120_000);
});

describe('tactics hook', () => {
  it('pulls a blow in its windup, lets a committed one finish, and starts nothing while the order stands', async () => {
    // No referee system here: the order is set by hand, so the hook is tested on its own.
    const sim = await makeSim({ design: 'savate', x: -0.35, y: 0, yaw: 0 }, { design: 'haymaker', x: 0.35, y: 0, yaw: Math.PI });
    const { ctx } = sim;
    const [me, him] = ctx.robots;
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    sim.seconds(0.6);
    const c = controllerOf(me)!;
    const ref = (ctx.referee = { ...newRefereeState(), active: true, since: ctx.time, down: [false, true] });
    him.intent = guard;
    const def = c.skillFor('cross') ?? SKILLS.cross!;
    // Windup: pulled.
    expect(c.startSkill(def, 'head', 0.3)).toBe(true);
    expect(c.skills.run?.phase).toBe('windup');
    ref.orders[0] = { goal: null };
    me.intent = player('cross');
    sim.seconds(0.004);
    expect(c.skills.run).toBeNull();
    // While the order stands, the all-out cross intent starts nothing.
    let started = 0;
    sim.seconds(1, () => { if (c.skills.run) started++; });
    expect(started).toBe(0);
    // Committed: finishes.
    ref.orders[0] = null;
    me.intent = null; // no intent: the tactics leave the runner alone
    sim.seconds(0.5);
    expect(c.startSkill(def, 'head', 1)).toBe(true);
    const run = c.skills.run!;
    const t0 = ctx.time;
    while (c.skills.run === run && run.phase === 'windup' && ctx.time - t0 < 2) sim.step();
    expect(c.skills.run).toBe(run);
    expect(run.phase).not.toBe('windup');
    ref.orders[0] = { goal: null };
    sim.step(4);
    expect(c.skills.run).toBe(run); // committed: not pulled
    sim.dispose();
  }, 60_000);
});
