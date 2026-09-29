// Strikes: for every strike ability of every design, the fighter walks in from out of range on
// an intent and throws. A trial is clean when the strike lands on the standing target and the
// thrower stays on its feet; every ability must be clean in >= 80% of trials.
import { describe, expect, it } from 'vitest';
import { availableSkills, controllerOf, SKILLS } from '../../src/physics/control';
import type { SkillId } from '../../src/physics/control';
import { isStrikeSkill } from '../../src/physics/control/skills';
import { comPos, HUMANOIDS, intent, isDown, makeSim } from './helpers';

const TRIALS: ReadonlyArray<{ x: number; y: number; yaw: number }> = [
  { x: 1.3, y: 0, yaw: Math.PI },
  { x: 1.45, y: 0.12, yaw: Math.PI - 0.15 },
  { x: 1.6, y: -0.12, yaw: Math.PI + 0.15 },
  { x: 1.35, y: -0.2, yaw: Math.PI },
  { x: 1.7, y: 0.2, yaw: Math.PI - 0.1 },
];
const TRIAL_S = 12;
const MIN_LAND_RATE = 0.8;
const TARGET = 'bruiser';

interface Trial {
  landed: boolean;
  fell: boolean;
  speed: number;
  time: number;
}

async function trial(design: string, id: SkillId, place: { x: number; y: number; yaw: number }): Promise<Trial> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: TARGET, ...place });
  const { ctx } = sim;
  const [me, dummy] = ctx.robots;
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  sim.seconds(0.8);
  const c = controllerOf(me)!;
  const z0 = comPos(ctx, me)[2];
  const def = SKILLS[id]!;
  me.intent = intent(id, def.defaultZone, 0.7);
  let fell = false;
  let done = -1;
  const t0 = ctx.time;
  const steps = Math.round(TRIAL_S / ctx.dt);
  for (let i = 0; i < steps && done < 0; i++) {
    sim.step();
    if (isDown(ctx, me, z0)) fell = true;
    if (c.skills.stats.thrown > 0 && !c.skills.active()) done = ctx.time - t0;
  }
  me.intent = null;
  // Let the exchange play out: a strike that lands but dumps its thrower counts as a fall.
  sim.seconds(1.5, () => { if (isDown(ctx, me, z0)) fell = true; });
  const out = { landed: c.skills.stats.landed > 0, fell, speed: c.skills.stats.lastLandedSpeed, time: done };
  void dummy;
  sim.dispose();
  return out;
}

describe('strikes land from range', () => {
  for (const design of HUMANOIDS) {
    it(`${design} lands every strike ability`, async () => {
      const probe = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: TARGET, x: 8, y: 0, yaw: Math.PI });
      const strikes = availableSkills(probe.ctx.robots[0]).filter((s) => isStrikeSkill(SKILLS[s]!));
      probe.dispose();
      const failures: string[] = [];
      for (const id of strikes) {
        const results: Trial[] = [];
        for (const place of TRIALS) results.push(await trial(design, id, place));
        const landed = results.filter((t) => t.landed).length;
        const falls = results.filter((t) => t.fell).length;
        const clean = results.filter((t) => t.landed && !t.fell).length;
        const speeds = results.filter((t) => t.landed).map((t) => t.speed);
        const mean = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
        console.log(`${design} ${id.padEnd(12)} clean ${clean}/${results.length} (landed ${landed}, falls ${falls}) mean ${mean.toFixed(1)} m/s times ${results.map((t) => t.time.toFixed(1)).join(' ')}`);
        if (clean / results.length < MIN_LAND_RATE) failures.push(`${id} clean ${clean}/${results.length} (landed ${landed}, falls ${falls})`);
      }
      expect(strikes.length).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }, 900_000);
  }
});
