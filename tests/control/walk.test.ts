// Footwork: each humanoid walks 1.5 m forward and back without falling or needing to be caught.
import { describe, expect, it } from 'vitest';
import { controllerOf } from '../../src/physics/control';
import { comPos, HUMANOIDS, isDown, loneRobot } from './helpers';

const DIST_M = 1.5;
const LEG_TIMEOUT_S = 20;
const ARRIVE_TOL_M = 0.1;
const SETTLE_S = 1; // stand still between the legs

describe('walking', () => {
  for (const id of HUMANOIDS) {
    it(`${id} walks ${DIST_M} m forward and back`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1);
      const c = controllerOf(r)!;
      const z0 = comPos(ctx, r)[2];
      const start = c.gait.currentFrame();
      let down = false;
      const times: number[] = [];
      for (const dx of [DIST_M, 0]) {
        c.goal = { x: start.x + dx, y: start.y, heading: start.heading };
        const t0 = ctx.time;
        let arrived = -1;
        const legSteps = Math.round(LEG_TIMEOUT_S / ctx.dt);
        for (let i = 0; i < legSteps && arrived < 0; i++) {
          sim.step();
          if (isDown(ctx, r, z0)) down = true;
          if (c.gait.phase !== 'double' || !c.gait.bothPlanted()) continue;
          const f = c.gait.currentFrame();
          if (Math.hypot(f.x - (start.x + dx), f.y - start.y) < ARRIVE_TOL_M) arrived = ctx.time - t0;
        }
        times.push(arrived);
        c.goal = null;
        sim.seconds(SETTLE_S, () => { if (isDown(ctx, r, z0)) down = true; });
      }
      console.log(`${id}: forward ${times[0].toFixed(1)} s, back ${times[1].toFixed(1)} s, steps ${c.gait.stepsTaken}, capture steps ${c.gait.captureSteps}`);
      expect(down).toBe(false);
      expect(times[0]).toBeGreaterThan(0);
      expect(times[1]).toBeGreaterThan(0);
      sim.dispose();
    }, 240_000);
  }
});
