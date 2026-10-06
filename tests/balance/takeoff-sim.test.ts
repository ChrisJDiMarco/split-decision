// The take-off hook for flashy moves (docs/design/balance-engine.md §5.3) on the real body, before
// any flashy move uses it: asked for a take-off off the lead foot with the COM moving forward, the
// balance engine shifts the weight onto that sole without a step, says it is ready inside the
// launch window with the DCM on the plan, and, the move called off, the body recovers on its feet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controllerOf } from '../../src/physics/control';
import { CONTROL } from '../../src/physics/control/balance/config';
import { comPos, isDown, loneRobot } from '../control/helpers';
import { measuredCop } from './contact-cop';

const ASK_V = 0.2; // m/s forward at take-off
const LEAD_S = 0.6; // take-off this long after the request

describe('take-off planning (sim)', () => {
  const saved = { ...CONTROL };
  beforeAll(() => {
    CONTROL.balance = 'dcm';
    CONTROL.inertialize = true;
  });
  afterAll(() => {
    CONTROL.balance = saved.balance;
    CONTROL.inertialize = saved.inertialize;
  });

  for (const id of ['savate', 'pylon']) {
    it(`${id}: weight onto the support sole, ready on time at the asked velocity, recovers when called off`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1.5);
      const c = controllerOf(r)!;
      const e = c.engine!;
      expect(e).toBeTruthy();
      const z0 = comPos(ctx, r)[2];
      const s0 = c.lastSense!;
      const h = s0.heading;
      const t0 = ctx.time;
      const at = t0 + LEAD_S;
      expect(e.requestTakeoff({ support: 'l', at, comVel: [ASK_V * Math.cos(h), ASK_V * Math.sin(h)] }, t0)).toBe(true);
      const steps0 = c.gait.stepsTaken;
      let readyAt = NaN, vReady = NaN, errReady = NaN, loadL = 0, n = 0;
      sim.seconds(LEAD_S + 0.05, () => {
        const st = e.takeoffState;
        const s = c.lastSense!;
        const cop = ctx.time > at - 0.1 ? measuredCop(ctx, r) : null;
        if (cop) {
          // Near the launch the support sole carries the weight: the measured COP's place between
          // the two soles (0 on the lead sole's centre, 1 on the rear's).
          const l = s.feet.l.sole, rr = s.feet.r.sole;
          const dx = rr[0] - l[0], dy = rr[1] - l[1];
          const u = ((cop[0] - l[0]) * dx + (cop[1] - l[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy);
          loadL += 1 - Math.min(1, Math.max(0, u));
          n++;
        }
        if (st.ready && Number.isNaN(readyAt)) {
          readyAt = ctx.time;
          vReady = s.comVel[0] * Math.cos(h) + s.comVel[1] * Math.sin(h);
          errReady = st.xiErr;
        }
      });
      console.log(`${id}: ready at ${(readyAt - at).toFixed(3)} s from the asked take-off, COM ${vReady.toFixed(2)} m/s (asked ${ASK_V}), DCM error ${(errReady * 100).toFixed(1)} cm, lead-sole load share ${(loadL / Math.max(1, n)).toFixed(2)}, steps ${c.gait.stepsTaken - steps0}`);
      expect(c.gait.stepsTaken).toBe(steps0);
      expect(Number.isNaN(readyAt)).toBe(false);
      expect(Math.abs(readyAt - at)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(vReady).toBeGreaterThan(0.5 * ASK_V);
      expect(vReady).toBeLessThan(1.5 * ASK_V);
      expect(loadL / Math.max(1, n)).toBeGreaterThan(0.8);
      // Called off: the engine plans from the body as it is (a step catches the forward DCM).
      e.cancelTakeoff();
      let down = false;
      sim.seconds(2.5, () => {
        if (isDown(ctx, r, z0)) down = true;
      });
      expect(down).toBe(false);
      expect(e.takeoffState.active).toBe(false);
      sim.dispose();
    }, 120_000);
  }
});
