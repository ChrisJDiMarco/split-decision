// Pace on the real body (balance engine, MuJoCo): a combination intent runs whole, its steps chained
// back to back; a feint shows a sold, telegraphed windup that the openings system reads as a feint,
// and a low feint keeps the foot on the canvas; a strike asked for out of range is walked into and
// thrown from the footing the body has, without falling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Intent } from '../../src/core/protocol';
import { controllerOf } from '../../src/physics/control';
import { CONTROL } from '../../src/physics/control/balance/config';
import { latestRead, openingsSystem } from '../../src/physics/openings';
import { comPos, intent, isDown, makeSim, SYSTEMS, type Sim } from '../control/helpers';

const WITH_READS = [...SYSTEMS, openingsSystem];

async function face(gap: number, design = 'savate'): Promise<Sim> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: 'savate', x: gap, y: 0, yaw: Math.PI }, { systems: WITH_READS });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  sim.seconds(1.0);
  return sim;
}

interface Start { t: number; id: string; single: boolean }

describe('pace on the balance engine (sim)', () => {
  const saved = { ...CONTROL };
  beforeAll(() => {
    CONTROL.balance = 'dcm';
    CONTROL.inertialize = true;
  });
  afterAll(() => {
    CONTROL.balance = saved.balance;
    CONTROL.inertialize = saved.inertialize;
  });

  it('a combination runs whole in the body, each step chained from the last', async () => {
    const sim = await face(0.85);
    const { ctx } = sim;
    const me = ctx.robots[0];
    const c = controllerOf(me)!;
    const z0 = comPos(ctx, me)[2];
    const combo: Intent = { ...intent('combo', 'head', 0.7), combo: ['jab', 'cross', 'jab'] };
    me.intent = combo;
    const starts: Start[] = [];
    let last = c.skills.run;
    let fell = false;
    sim.seconds(4, () => {
      const run = c.skills.run;
      if (run && run !== last && run.def.kind === 'arm') starts.push({ t: ctx.time, id: run.def.id, single: c.gait.phase === 'single' });
      last = run;
      if (isDown(ctx, me, z0)) fell = true;
    });
    sim.dispose();
    console.log(`combo starts ${starts.map((s) => `${s.id}@${s.t.toFixed(2)}${s.single ? '(step)' : ''}`).join(' ')}; stats ${JSON.stringify(c.tactics.comboStats)}`);
    expect(fell).toBe(false);
    expect(starts.slice(0, 3).map((s) => s.id)).toEqual(['jab', 'cross', 'jab']);
    expect(c.tactics.comboStats.completed).toBeGreaterThanOrEqual(1);
    // Chained: the cross follows the jab inside a second (a step in included); the whole combination
    // goes inside 3 s although each blow knocks the standing target back (the cross by ~0.3 m: the
    // last jab needs two steps in first).
    expect(starts[1].t - starts[0].t).toBeLessThan(1.0);
    expect(starts[2].t - starts[0].t).toBeLessThan(3.0);
  }, 120_000);

  it('a feint shows a sold windup past the reflex threshold, is pulled by choice and read as a feint', async () => {
    const sim = await face(0.8);
    const { ctx } = sim;
    const me = ctx.robots[0];
    const c = controllerOf(me)!;
    me.intent = intent('feint', 'head', 0.6);
    let peak = 0, shown = 0, reachedStrike = false, id = '';
    let first: unknown = null;
    sim.seconds(1.2, () => {
      const run = c.skills.run;
      if (run && !first && run.def.kind === 'arm') {
        first = run;
        id = run.def.id;
      }
      if (run && run === first) {
        peak = Math.max(peak, me.windup);
        if (run.phase === 'windup') shown = Math.max(shown, run.t);
        else reachedStrike = true;
      }
    });
    const read = latestRead(ctx, 0);
    sim.dispose();
    console.log(`feint ${id}: telegraph peak ${peak.toFixed(2)}, shown ${shown.toFixed(2)} s, read ${JSON.stringify(read)}`);
    expect(first).not.toBeNull();
    expect(reachedStrike).toBe(false);
    expect(c.skills.lastEnd).toBe('cancelled');
    expect(peak).toBeGreaterThanOrEqual(0.55);
    expect(shown).toBeGreaterThanOrEqual(0.18);
    expect(read?.deliberate).toBe(true);
    expect(read?.level).toBe('high');
  }, 120_000);

  it('a low feint shifts the weight and turns the hips, the foot stays on the canvas', async () => {
    const sim = await face(0.8);
    const { ctx } = sim;
    const me = ctx.robots[0];
    const c = controllerOf(me)!;
    const z0 = comPos(ctx, me)[2];
    me.intent = intent('feint', 'left_leg', 0.6);
    let leg = false, footUp = 0, fell = false;
    sim.seconds(1.5, () => {
      const run = c.skills.run;
      if (run?.def.kind === 'leg') {
        leg = true;
        footUp = Math.max(footUp, c.lastSense!.feet[run.def.side!].height);
      }
      if (isDown(ctx, me, z0)) fell = true;
    });
    const read = latestRead(ctx, 0);
    sim.dispose();
    console.log(`low feint: foot up ${(footUp * 100).toFixed(1)} cm, read ${JSON.stringify(read)}`);
    expect(leg).toBe(true);
    expect(fell).toBe(false);
    expect(footUp).toBeLessThan(0.08);
    expect(read?.level).toBe('low');
  }, 120_000);

  it('a strike out of range is walked into and thrown from the footing the body has', async () => {
    for (const design of ['savate', 'haymaker']) {
      const sim = await face(1.3, design);
      const { ctx } = sim;
      const me = ctx.robots[0];
      const c = controllerOf(me)!;
      const z0 = comPos(ctx, me)[2];
      const t0 = ctx.time;
      me.intent = intent('cross', 'head', 0.8);
      let start: Start | null = null, fell = false;
      sim.seconds(3, () => {
        const run = c.skills.run;
        if (run && !start && run.def.kind === 'arm') start = { t: ctx.time - t0, id: run.def.id, single: c.gait.phase === 'single' };
        if (isDown(ctx, me, z0)) fell = true;
      });
      sim.dispose();
      const st = start as Start | null;
      console.log(`${design}: ${st ? `${st.id} started after ${st.t.toFixed(2)} s${st.single ? ' from a step' : ''}` : 'no strike'}, landed ${c.skills.stats.landed}`);
      expect(fell).toBe(false);
      expect(st).not.toBeNull();
      expect(st!.t).toBeLessThan(1.8);
      expect(c.skills.stats.landed).toBeGreaterThan(0);
    }
  }, 240_000);
});
