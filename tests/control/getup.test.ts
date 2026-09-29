// Getting up: a robot shoved clean over must be back on its feet (upright, at stance height,
// balanced for STAY_UP_S) within GETUP_S of going down.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { HUMANOIDS, loneRobot, pelvisPos, push, torsoUp } from './helpers';

const GETUP_S = 8;
const SHOVE_ACCEL = 12; // m/s² on the whole robot for SHOVE_S: a 3 m/s shove, far past recovery
const SHOVE_S = 0.25;
const STAY_UP_S = 1;
const UP_UPRIGHT = 0.85; // torso up-axis z
const UP_HEIGHT = 0.85; // × stance pelvis height
const SHOVES: Record<string, Vec3> = { forward: [1, 0, 0], diagonal: [0.8, 0.6, 0] };

describe('getting up', () => {
  for (const id of HUMANOIDS) {
    for (const [name, dir] of Object.entries(SHOVES)) {
      it(`${id} is back up within ${GETUP_S} s of a ${name} shove`, async () => {
        const sim = await loneRobot(id);
        const { ctx } = sim;
        const r = ctx.robots[0];
        sim.seconds(1);
        const c = controllerOf(r)!;
        const f = SHOVE_ACCEL * c.mass;
        const shoveAt = ctx.time;
        push(sim, r, [dir[0] * f, dir[1] * f, 0], SHOVE_S);
        let fellAt = -1, upSince = -1, stoodAt = -1;
        sim.seconds(GETUP_S + STAY_UP_S + 2, () => {
          for (const e of ctx.events) if (e.kind === 'fall' && e.corner === 0 && fellAt < 0) fellAt = ctx.time;
          ctx.events.length = 0;
          const up = fellAt >= 0 && !r.down && !c.getUp.active && torsoUp(ctx, r) > UP_UPRIGHT && pelvisPos(ctx, r)[2] > UP_HEIGHT * c.stance.pelvisHeight;
          if (!up) upSince = -1;
          else if (upSince < 0) upSince = ctx.time;
          else if (stoodAt < 0 && ctx.time - upSince >= STAY_UP_S) stoodAt = upSince;
        });
        const took = stoodAt >= 0 ? stoodAt - fellAt : Infinity;
        console.log(`${id} ${name}: down ${fellAt >= 0 ? (fellAt - shoveAt).toFixed(2) : '-'} s after the shove, back up ${Number.isFinite(took) ? took.toFixed(2) : 'never'} s later, attempts ${c.getUp.attempts}`);
        expect(fellAt).toBeGreaterThanOrEqual(0);
        expect(took).toBeLessThanOrEqual(GETUP_S);
        sim.dispose();
      }, 120_000);
    }
  }
});
