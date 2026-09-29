// Push recovery: a shove at the torso (impulse via xfrc_applied) worth a COM velocity change of
// PUSH_DV, frontal and lateral. The robot must stay up (ankles, gyro core, capture steps).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { comPos, HUMANOIDS, isDown, loneRobot, push } from './helpers';

const PUSH_DV = 0.6; // m/s of COM velocity: ~150 N·s on a 250 kg robot
const PUSH_S = 0.1;
const DIRECTIONS: Record<string, Vec3> = { frontal: [-1, 0, 0], rear: [1, 0, 0], left: [0, 1, 0], right: [0, -1, 0] };

describe('push recovery', () => {
  for (const id of HUMANOIDS) {
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      it(`${id} recovers from a ${name} push`, async () => {
        const sim = await loneRobot(id);
        const { ctx } = sim;
        const r = ctx.robots[0];
        sim.seconds(1.5);
        const c = controllerOf(r)!;
        const z0 = comPos(ctx, r)[2];
        const f = (PUSH_DV * c.mass) / PUSH_S;
        push(sim, r, [dir[0] * f, dir[1] * f, 0], PUSH_S);
        let down = false, sat = 0;
        sim.seconds(4, () => {
          if (isDown(ctx, r, z0)) down = true;
          sat = Math.max(sat, c.gyro?.saturation ?? 0);
        });
        console.log(`${id} ${name} push ${(PUSH_DV * c.mass).toFixed(0)} N·s: ${down ? 'FELL' : 'recovered'}, steps ${c.gait.stepsTaken}, peak gyro saturation ${sat.toFixed(2)}`);
        expect(down).toBe(false);
        sim.dispose();
      }, 60_000);
    }
  }
});
