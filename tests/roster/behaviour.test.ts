// The modern roster on the existing (procedural) controller: each fighter stands 20 s, takes a
// shove from four sides, and throws every ability from stance range without falling in most trials.
// Walking is measured and logged but not asserted: the WIP fast gait (src/physics/control/walk.ts)
// drops the iron-age designs too, and the next phase replaces it with mocap tracking.
// Heavy: run one design at a time, e.g. npx vitest run tests/roster/behaviour.test.ts -t savate
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { availableSkills, controllerOf, SKILLS } from '../../src/physics/control';
import type { SkillId } from '../../src/physics/control';
import { isStrikeSkill } from '../../src/physics/control/skills';
import { comPos, intent, isDown, isFinite, loneRobot, makeSim, push } from '../control/helpers';

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;
const HEIGHT: Record<string, number> = { firecracker: 1.3, savate: 1.73, haymaker: 1.82, pylon: 1.89 };
const PUSH_DV = 0.6; // m/s of COM velocity, as tests/control/push.test.ts
const PUSH_S = 0.1;
const DIRECTIONS: Record<string, Vec3> = { frontal: [-1, 0, 0], rear: [1, 0, 0], left: [0, 1, 0], right: [0, -1, 0] };
const TRIAL_S = 12;

/** Placements inside stance-footwork range (no walk-in), scaled to the fighter's height. */
function stancePlacements(id: string) {
  const d = 0.45 * HEIGHT[id] + 0.3;
  return [
    { x: d, y: 0, yaw: Math.PI },
    { x: d + 0.1, y: 0.1, yaw: Math.PI - 0.15 },
    { x: d - 0.05, y: -0.1, yaw: Math.PI + 0.15 },
  ];
}

describe('modern roster behaviour (procedural controller)', () => {
  for (const id of MODERN) {
    it(`${id} stands 20 s and recovers from pushes on four sides`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1);
      const c = controllerOf(r)!;
      const z0 = comPos(ctx, r)[2];
      let down = false;
      sim.seconds(20, () => { if (isDown(ctx, r, z0)) down = true; });
      expect(down).toBe(false);
      for (const [name, dir] of Object.entries(DIRECTIONS)) {
        const f = (PUSH_DV * c.mass) / PUSH_S;
        let fell = false, sat = 0;
        push(sim, r, [dir[0] * f, dir[1] * f, 0], PUSH_S);
        sim.seconds(4, () => {
          if (isDown(ctx, r, z0)) fell = true;
          sat = Math.max(sat, c.gyro?.saturation ?? 0);
        });
        console.log(`${id} ${name} push ${(PUSH_DV * c.mass).toFixed(0)} N·s: ${fell ? 'FELL' : 'recovered'}, peak gyro saturation ${sat.toFixed(2)}`);
        expect(fell).toBe(false);
      }
      expect(isFinite(ctx)).toBe(true);
      sim.dispose();
    }, 300_000);

    it(`${id} walk 1.5 m (measured only)`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1);
      const c = controllerOf(r)!;
      const z0 = comPos(ctx, r)[2];
      const start = c.gait.currentFrame();
      c.goal = { x: start.x + 1.5, y: start.y, heading: start.heading };
      let down = -1, arrived = -1;
      const t0 = ctx.time;
      for (let i = 0; i < 20_000 && arrived < 0 && down < 0; i++) {
        sim.step();
        if (isDown(ctx, r, z0)) down = ctx.time - t0;
        if (c.gait.phase !== 'double' || !c.gait.bothPlanted()) continue;
        const f = c.gait.currentFrame();
        if (Math.hypot(f.x - (start.x + 1.5), f.y - start.y) < 0.1) arrived = ctx.time - t0;
      }
      console.log(`${id} walk 1.5 m: ${arrived >= 0 ? `arrived in ${arrived.toFixed(1)} s` : down >= 0 ? `FELL after ${down.toFixed(1)} s` : 'timed out'}, steps ${c.gait.stepsTaken}`);
      expect(isFinite(ctx)).toBe(true);
      sim.dispose();
    }, 300_000);

    it(`${id} throws every ability from stance range without falling in most trials`, async () => {
      const probe = await makeSim({ design: id, x: 0, y: 0, yaw: 0 }, { design: id, x: 8, y: 0, yaw: Math.PI });
      const strikes = availableSkills(probe.ctx.robots[0]).filter((s) => isStrikeSkill(SKILLS[s]!));
      probe.dispose();
      const failures: string[] = [];
      for (const sk of strikes) {
        let falls = 0, landed = 0;
        const places = stancePlacements(id);
        for (const place of places) {
          const sim = await makeSim({ design: id, x: 0, y: 0, yaw: 0 }, { design: id, ...place });
          const { ctx } = sim;
          const me = ctx.robots[0];
          sim.seconds(0.5);
          sim.release(0);
          sim.release(1);
          sim.seconds(0.8);
          const c = controllerOf(me)!;
          const z0 = comPos(ctx, me)[2];
          me.intent = intent(sk as SkillId, SKILLS[sk]!.defaultZone, 0.7);
          let fell = false;
          const steps = Math.round(TRIAL_S / ctx.dt);
          for (let i = 0; i < steps; i++) {
            sim.step();
            if (isDown(ctx, me, z0)) fell = true;
            if (c.skills.stats.thrown > 0 && !c.skills.active()) break;
          }
          me.intent = null;
          sim.seconds(1.5, () => { if (isDown(ctx, me, z0)) fell = true; });
          if (fell) falls++;
          if (c.skills.stats.landed > 0) landed++;
          sim.dispose();
        }
        console.log(`${id} ${sk.padEnd(11)} landed ${landed}/${places.length}, falls ${falls}`);
        if (falls * 2 > places.length) failures.push(`${sk}: ${falls}/${places.length} falls`);
      }
      expect(strikes.length).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }, 900_000);
  }
});
