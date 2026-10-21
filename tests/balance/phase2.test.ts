// Balance engine Phase 2 (docs/design/balance-engine.md §3.6, §9): joint impedance and the inverse-dynamics
// feed-forward on the real body, and the held stance re-formed in one step.
//   impedance          standing, the stance legs run soft (ankles 0.3, knee and hip pitch/roll 0.5, hip yaw
//                      0.35, kv the square root), a swing leg stiff
//   inverse dynamics   'full': standing still, the ground force it plans is the robot's weight, its COP
//                      the COM's projection, and the planted legs keep torque in reserve; 'reaction' (the
//                      default): nothing added on two feet, a walking swing's reaction carried by the stance
//   held stance        a foot knocked out of its slot is stepped back in one step around the one that
//                      carries the weight
//   shoves             1.1 m/s stance shoves the engine is known to catch, in at most two steps
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controllerOf } from '../../src/physics/control';
import { CONTROL } from '../../src/physics/control/balance/config';
import { DcmPlan } from '../../src/physics/control/balance/dcm';
import { FootstepPlanner } from '../../src/physics/control/balance/footsteps';
import { IMPEDANCE } from '../../src/physics/control/balance/impedance';
import { INVERSE_DYNAMICS } from '../../src/physics/control/feedforward';
import { BALANCE_TUNING } from '../../src/physics/control/balance/index';
import { Gait } from '../../src/physics/control/gait';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { stanceFor } from '../../src/physics/control/stance';
import { design } from '../../src/robots/designs';
import type { Vec3 } from '../../src/core/types';
import type { SimEvent } from '../../src/core/protocol';
import { comPos, isDown, loneRobot } from '../control/helpers';

describe('phase 2 on the body (sim)', () => {
  const saved = { ...CONTROL };
  beforeAll(() => {
    CONTROL.balance = 'dcm';
    CONTROL.inertialize = true;
  });
  afterAll(() => {
    CONTROL.balance = saved.balance;
    CONTROL.inertialize = saved.inertialize;
  });

  it('standing (full inverse dynamics): soft stance legs, the planned ground force is the weight at the COM, torque in reserve', async () => {
    const full = INVERSE_DYNAMICS.full;
    INVERSE_DYNAMICS.full = 1;
    const sim = await loneRobot('savate');
    const { ctx } = sim;
    const r = ctx.robots[0];
    sim.seconds(2.5);
    const c = controllerOf(r)!;
    expect(c.engine).toBeTruthy();
    const kp = r.mem.gainScale as Float64Array, kv = r.mem.dampScale as Float64Array;
    for (const side of ['l', 'r'] as const) {
      const m = c.jm.leg[side];
      expect(kp[m.anklePitch]).toBeCloseTo(BALANCE_TUNING.stanceAnkleKp, 6);
      expect(kp[m.knee]).toBeCloseTo(IMPEDANCE.leg, 6);
      expect(kp[m.hipPitch]).toBeCloseTo(IMPEDANCE.leg, 6);
      expect(kp[m.hipRoll]).toBeCloseTo(IMPEDANCE.leg, 6);
      expect(kp[m.hipYaw]).toBeCloseTo(BALANCE_TUNING.stanceHipYawKp, 6);
      expect(kv[m.knee]).toBeCloseTo(Math.sqrt(IMPEDANCE.leg), 6);
    }
    const p = c.idyn!.probe;
    const mg = ctx.model.body_subtreemass[r.rootBody] * 9.81;
    expect(Math.abs(p.force[2] - mg) / mg).toBeLessThan(0.03);
    expect(Math.hypot(p.force[0], p.force[1])).toBeLessThan(0.05 * mg);
    const com = comPos(ctx, r);
    expect(Math.hypot(p.copWant[0] - com[0], p.copWant[1] - com[1])).toBeLessThan(0.03);
    expect(c.engine!.state.torqueReserve).toBeGreaterThan(0.3);
    expect(c.engine!.state.torqueReserve).toBeLessThanOrEqual(1);
    sim.dispose();
    INVERSE_DYNAMICS.full = full;
  }, 60_000);

  it('reaction feed-forward: nothing added on two feet, a walking swing carried by the stance leg', async () => {
    expect(INVERSE_DYNAMICS.full).toBe(0);
    const sim = await loneRobot('savate');
    const { ctx } = sim;
    const r = ctx.robots[0];
    sim.seconds(1.5);
    const c = controllerOf(r)!;
    const p = c.idyn!.probe;
    expect(p.legShare).toBe(0);
    // Walk 1.5 m ahead: the swings' reaction goes on the stance leg (some share of it, every swing).
    const f = c.gait.currentFrame();
    c.goal = { x: f.x + Math.cos(f.heading) * 1.5, y: f.y + Math.sin(f.heading) * 1.5, heading: f.heading };
    let swingTicks = 0, driven = 0;
    sim.seconds(3, () => {
      if (ctx.tick % 2 || c.gait.phase !== 'single') return;
      swingTicks++;
      if (p.legShare > 0) driven++;
    });
    expect(swingTicks).toBeGreaterThan(50);
    expect(driven / swingTicks).toBeGreaterThan(0.5);
    sim.dispose();
  }, 60_000);

  // (Cases the engine catches with margin in this scene; the full matrix is tools/balance-drills.ts --drills push.)
  for (const [id, dir] of [['haymaker', 0], ['savate', 0], ['pylon', 0], ['firecracker', 270], ['haymaker', 270]] as const) {
    it(`${id} catches a 1.1 m/s shove at ${dir}° in at most two steps`, async () => {
      const sim = await loneRobot(id);
      const { ctx } = sim;
      const r = ctx.robots[0];
      // (loneRobot parks a striker opposite: the bearing it squares up to stays put.)
      sim.seconds(1.2);
      const c = controllerOf(r)!;
      const z0 = comPos(ctx, r)[2];
      const heading = c.gait.currentFrame().heading + (dir * Math.PI) / 180;
      const f = (1.1 * c.mass) / 0.1;
      const force: Vec3 = [Math.cos(heading) * f, Math.sin(heading) * f, 0];
      const body = r.parts.get('torso')!.body;
      const xf = ctx.data.xfrc_applied as Float64Array;
      const t0 = c.probe.touchdowns;
      let fell = false;
      for (let i = 0; i < 100; i++) {
        xf[body * 6] += force[0];
        xf[body * 6 + 1] += force[1];
        sim.step();
        xf[body * 6] -= force[0];
        xf[body * 6 + 1] -= force[1];
      }
      sim.seconds(4, () => {
        for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === 0) fell = true;
        ctx.events.length = 0;
        if (isDown(ctx, r, z0)) fell = true;
      });
      expect(fell).toBe(false);
      expect(c.probe.touchdowns - t0).toBeLessThanOrEqual(2);
      sim.dispose();
    }, 60_000);
  }
});

describe('held stance re-formed in one step', () => {
  const geo = humanoidGeometry(design('savate'));
  const stance = stanceFor(geo, { widthFraction: 1.02 });

  it('steps the foot knocked out of its slot back around the weight-bearing one', () => {
    const gait = new Gait(geo, stance);
    const frame = { x: 0, y: 0, heading: 0 };
    for (const side of ['l', 'r'] as const) {
      gait.feet[side].phase = 'planted';
      gait.feet[side].place = gait.slot(side, frame);
    }
    // A catch step put the right foot 0.3 m out to the side; the weight (the DCM) is over the left foot.
    const l = gait.feet.l.place;
    gait.feet.r.place = { ...gait.feet.r.place, y: gait.feet.r.place.y - 0.3 };
    const planner = new FootstepPlanner(geo, stance, gait);
    const plan = planner.plan({
      time: 0, omega: 3.4, goal: null, bearing: 0, oppDist: 3, aggression: 0.5, speed: null, cmpNow: [l.x, l.y],
      shift: [0, 0], swing: null, doubleS: 0.5, fromRest: true, lastSide: null, opp: null, xi: [l.x, l.y],
    }, new DcmPlan());
    expect(plan).toBe('drag');
    expect(planner.count).toBe(1);
    const s = planner.steps[0];
    expect(s.side).toBe('r');
    // Into its slot of the stance frame the left foot stands in.
    const anchored = { x: l.x - gait.slot('l', { x: 0, y: 0, heading: 0 }).x, y: l.y - gait.slot('l', { x: 0, y: 0, heading: 0 }).y, heading: 0 };
    const slot = gait.slot('r', anchored);
    expect(Math.hypot(s.place.x - slot.x, s.place.y - slot.y)).toBeLessThan(0.02);
  });
});
