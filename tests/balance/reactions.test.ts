// Balance engine Phase 4 (docs/design/balance-engine.md §6, §9): reactions on the real body.
//   hit        a 40 N·s blow to the torso is felt (the proprioceptive detector), absorbed and recovered from
//              without a fall, in at most two steps
//   no ghost   walking in and standing in the guard, nothing is felt as a hit
//   brace      a shove past capture: the brace starts before anything but a sole touches the canvas, the
//              hands go first and the head does not
//   pre-brace  his windup past 0.55 within 1.35 m: the pelvis drops and the guard and waist stiffen
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/core/protocol';
import type { Vec3 } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { CONTROL } from '../../src/physics/control/balance/config';
import { REACTIONS } from '../../src/physics/control/balance/reactions';
import { PACE } from '../../src/physics/control/tactics';
import { SYSTEMS } from '../../src/physics/systems';
import { comPos, intent, isDown, loneRobot, makeSim, type Sim } from '../control/helpers';
import { CanvasContacts } from './canvas-contact';

/** Push robot 0's `part` with `impulse` N·s over `s` seconds from `dir` (world, unit), stepping the sim. */
function blow(sim: Sim, part: string, dir: Vec3, impulse: number, s: number, each?: () => void): void {
  const { ctx } = sim;
  const r = ctx.robots[0];
  const body = r.parts.get(part)!.body;
  const f = impulse / s;
  for (let i = 0; i < Math.round(s / ctx.dt); i++) {
    const xf = ctx.data.xfrc_applied as Float64Array;
    xf[body * 6] += dir[0] * f;
    xf[body * 6 + 1] += dir[1] * f;
    sim.step();
    const xf2 = ctx.data.xfrc_applied as Float64Array;
    xf2[body * 6] -= dir[0] * f;
    xf2[body * 6 + 1] -= dir[1] * f;
    each?.();
  }
}

describe('phase 4 reactions (sim)', () => {
  const saved = { ...CONTROL };
  beforeAll(() => {
    CONTROL.balance = 'dcm';
    CONTROL.inertialize = true;
  });
  afterAll(() => {
    CONTROL.balance = saved.balance;
    CONTROL.inertialize = saved.inertialize;
  });

  it('a 40 N·s body shot is felt, absorbed and recovered from in at most two steps', async () => {
    const sim = await loneRobot('savate');
    const { ctx } = sim;
    const r = ctx.robots[0];
    sim.seconds(1.5);
    const c = controllerOf(r)!;
    const e = c.engine!;
    const z0 = comPos(ctx, r)[2];
    const h = c.gait.currentFrame().heading;
    const hits0 = e.reactions.counts.hits, touch0 = c.probe.touchdowns;
    const modes = new Set<string>();
    blow(sim, 'torso', [-Math.cos(h), -Math.sin(h), 0], 40, 0.012, () => modes.add(e.state.mode));
    let fell = false;
    sim.seconds(2.5, () => {
      modes.add(e.state.mode);
      if (isDown(ctx, r, z0) || r.down) fell = true;
      ctx.events.length = 0;
    });
    expect(fell).toBe(false);
    expect(e.reactions.counts.hits - hits0).toBeGreaterThanOrEqual(1);
    expect(e.reactions.hit!.impulse).toBeGreaterThan(20);
    expect(modes.has('absorb') || modes.has('recover')).toBe(true);
    expect(modes.has('brace')).toBe(false);
    expect(c.probe.touchdowns - touch0).toBeLessThanOrEqual(2);
    expect(e.state.mode).toBe('steady');
    sim.dispose();
  }, 60_000);

  it('walking in and holding the guard, nothing is felt as a hit', async () => {
    const sim = await makeSim({ design: 'savate', x: -2, y: 0, yaw: 0 }, { design: 'savate', x: 2, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
    const { ctx } = sim;
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    sim.seconds(0.8);
    // Footwork only (the approach drill's setting): no step-in jab at the edge of range.
    const jab = PACE.edgeJabAggression;
    PACE.edgeJabAggression = Infinity;
    for (const r of ctx.robots) r.intent = intent('close_distance', 'head', 0.5);
    sim.seconds(6, () => { ctx.events.length = 0; });
    PACE.edgeJabAggression = jab;
    for (const r of ctx.robots) {
      const e = controllerOf(r)!.engine!;
      expect(e.reactions.counts.hits).toBe(0);
      expect(e.reactions.counts.braces).toBe(0);
    }
    sim.dispose();
  }, 60_000);

  it('a shove past capture: braced before anything but a sole lands, hands first, never the head', async () => {
    for (const [design, deg] of [['firecracker', 0], ['savate', 180], ['pylon', 90]] as const) {
      const sim = await loneRobot(design);
      const { ctx } = sim;
      const r = ctx.robots[0];
      sim.seconds(1.5);
      const c = controllerOf(r)!;
      const e = c.engine!;
      const cc = new CanvasContacts(ctx, r);
      const h = c.gait.currentFrame().heading + (deg * Math.PI) / 180;
      let braceAt = -1, contactAt = -1, contact: string[] = [];
      const watch = (): void => {
        if (braceAt < 0 && e.state.mode === 'brace') braceAt = ctx.time;
        if (contactAt < 0) {
          const parts = cc.nonFoot(ctx);
          if (parts.length) {
            contactAt = ctx.time;
            contact = parts;
          }
        }
        for (const ev of ctx.events as SimEvent[]) void ev;
        ctx.events.length = 0;
      };
      blow(sim, 'torso', [Math.cos(h), Math.sin(h), 0], 2.2 * c.mass, 0.1, watch);
      sim.seconds(2, watch);
      expect(contactAt).toBeGreaterThan(0);
      expect(braceAt).toBeGreaterThan(0);
      expect(braceAt).toBeLessThanOrEqual(contactAt);
      expect(contact).not.toContain('head');
      expect(contact.some((p) => /^(fist|forearm)/.test(p))).toBe(true);
      sim.dispose();
    }
  }, 120_000);

  it('his windup inside reflex range: the pre-brace drops the pelvis and stiffens the guard', async () => {
    const sim = await makeSim({ design: 'haymaker', x: -0.6, y: 0, yaw: 0 }, { design: 'haymaker', x: 0.6, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
    const { ctx } = sim;
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    sim.seconds(1.2, () => { ctx.events.length = 0; });
    const [me, him] = ctx.robots;
    const c = controllerOf(me)!;
    const e = c.engine!;
    expect(e.reactions.preBrace).toBe(false);
    // His windup as the openings read it (the fighter in corner 1 is not driven: only his windup is shown).
    controllerOf(him)!.enabled = false;
    let pre = false, stiff = 0;
    sim.seconds(0.4, () => {
      him.windup = 0.8;
      him.skill = 'cross';
      ctx.events.length = 0;
      if (e.reactions.preBrace) {
        pre = true;
        const kp = me.mem.gainScale as Float64Array;
        stiff = Math.max(stiff, kp[c.jm.arm.l.elbow], kp[c.jm.waistPitch]);
      }
    });
    expect(pre).toBe(true);
    expect(stiff).toBeCloseTo(REACTIONS.preStiff, 6);
    sim.dispose();
  }, 60_000);
});
