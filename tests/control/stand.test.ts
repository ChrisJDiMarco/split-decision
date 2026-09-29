// Each humanoid stands unaided for 20 s: no falls, COM held over the support, feet planted.
import { describe, expect, it } from 'vitest';
import { controllerOf } from '../../src/physics/control';
import { comPos, HUMANOIDS, isDown, loneRobot, robotMaxQvel } from './helpers';

const STAND_S = 20;

describe('standing', () => {
  for (const id of HUMANOIDS) {
    it(`${id} stands for ${STAND_S} s`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1);
      const c = controllerOf(r)!;
      const z0 = comPos(ctx, r)[2];
      let down = false, maxErr = 0, maxV = 0;
      sim.seconds(STAND_S, () => {
        if (isDown(ctx, r, z0)) down = true;
        const s = c.lastSense!;
        maxErr = Math.max(maxErr, Math.hypot(s.com[0] - c.comRef[0], s.com[1] - c.comRef[1]));
        maxV = Math.max(maxV, robotMaxQvel(ctx, r));
      });
      console.log(`${id}: stood ${STAND_S}s, max COM error ${(maxErr * 1000).toFixed(1)} mm, steps ${c.gait.stepsTaken}, gyro saturation ${(c.gyro?.saturation ?? 0).toFixed(2)}, max |qvel| ${maxV.toFixed(2)}`);
      expect(down).toBe(false);
      expect(r.down).toBe(false);
      expect(maxErr).toBeLessThan(0.02);
      expect(c.gait.stepsTaken).toBe(0);
      sim.dispose();
    }, 120_000);
  }
});
