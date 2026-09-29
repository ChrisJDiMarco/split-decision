// The get-up lets go of the canvas only with the body over its feet: the COM and the capture
// point (where the COM is heading) both inside the soles. A COM behind the heels or a body still
// sliding toward the toes rises straight into a fall.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import type { Sense } from '../../src/physics/control/sense';
import { loneRobot } from './helpers';

const BEHIND_M = 0.3;
const SLIDE_M_S = 1.5;

function withCom(s: Sense, com: Vec3, vel: Vec3): Sense {
  const capture: Vec3 = [com[0] + vel[0] / s.omega0, com[1] + vel[1] / s.omega0, 0];
  return { ...s, com, comVel: vel, capture };
}

describe('get-up rise gate', () => {
  it('rises only with the COM and capture point over the soles', async () => {
    const sim = await loneRobot('striker');
    sim.seconds(1);
    const c = controllerOf(sim.ctx.robots[0])!;
    const s = c.lastSense!;
    const { l, r } = s.feet;
    const mid: Vec3 = [(l.sole[0] + r.sole[0]) / 2, (l.sole[1] + r.sole[1]) / 2, s.com[2]];
    const fwd: Vec3 = [Math.cos(s.heading), Math.sin(s.heading), 0];
    const still: Vec3 = [0, 0, 0];
    const behind: Vec3 = [mid[0] - fwd[0] * BEHIND_M, mid[1] - fwd[1] * BEHIND_M, mid[2]];
    const sliding: Vec3 = [fwd[0] * SLIDE_M_S, fwd[1] * SLIDE_M_S, 0];

    expect(c.getUp.overFeet(withCom(s, mid, still))).toBe(true);
    expect(c.getUp.overFeet(withCom(s, behind, still))).toBe(false);
    expect(c.getUp.overFeet(withCom(s, mid, sliding))).toBe(false);
    sim.dispose();
  }, 60_000);
});
