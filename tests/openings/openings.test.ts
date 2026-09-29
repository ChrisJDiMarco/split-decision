// Openings, stance and moveRisk computed from real MuJoCo states: two robots in the minimal test
// world with the full system stack (control, motors, damage, openings), then provoked into each
// situation: pushed off balance, knocked down (rising), turned away, a knee damaged, arms dropped,
// a strike thrown into air, a hard hit taken, parked on the cage.
import { afterEach, describe, expect, test } from 'vitest';
import { APOTHEM } from '../../src/core/arena-spec';
import type { Opening, RobotTelemetry } from '../../src/core/protocol';
import { controllerOf } from '../../src/physics/control';
import { SKILLS } from '../../src/physics/control/skills';
import { detectOpenings, isStunningHit, moveRisks, snapshot } from '../../src/physics/openings';
import { openingsSystem } from '../../src/physics/openings';
import { damageSystem } from '../../src/physics/damage';
import type { SimContext, SimSystem } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
import { controlSystem } from '../../src/physics/control';
import { intentSystem } from '../../src/physics/systems/intents';
import { motorSystem } from '../../src/physics/systems/motors';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { makeSim, push, type Placement, type Sim } from '../control/helpers';

let sim: Sim | null = null;
afterEach(() => {
  sim?.dispose();
  sim = null;
});

const tel = (s: Sim, c: 0 | 1): RobotTelemetry => buildTelemetry(s.ctx, s.ctx.robots[c], SYSTEMS);
const seenBy = (s: Sim, c: 0 | 1): Opening[] => tel(s, c).openings ?? [];

async function standoff(a: Placement, b: Placement, systems: readonly SimSystem[] = SYSTEMS): Promise<Sim> {
  const s = await makeSim(a, b, { systems });
  s.seconds(0.3);
  s.release(0);
  s.release(1);
  s.seconds(1.0);
  return s;
}

/** Steps `seconds` and collects every opening robot 0 sees along the way. */
function watch(s: Sim, seconds: number, each?: () => void): Set<Opening> {
  const seen = new Set<Opening>();
  for (let t = 0; t < seconds; t += 0.01) {
    s.step(10);
    each?.();
    for (const o of seenBy(s, 0)) seen.add(o);
  }
  return seen;
}

describe('openings from real MuJoCo states', () => {
  test('a fresh squared-up standoff shows no openings, an orthodox stance and a small angle', async () => {
    sim = await standoff({ design: 'savate', x: -0.75, y: 0, yaw: 0 }, { design: 'savate', x: 0.75, y: 0, yaw: Math.PI });
    for (const c of [0, 1] as const) {
      const t = tel(sim, c);
      expect(t.openings).toEqual([]);
      expect(t.stance).toBe('orthodox');
      expect(Math.abs(t.facingOffDeg ?? 99)).toBeLessThan(25);
      expect(t.facingOffDeg).not.toBe(0); // the stance is bladed, never perfectly square
    }
  });

  test('pushed hard: off balance and a saturated gyro, then down and rising', async () => {
    sim = await standoff({ design: 'savate', x: -1, y: 0, yaw: 0 }, { design: 'savate', x: 1, y: 0, yaw: Math.PI });
    const r1 = sim.ctx.robots[1];
    const during = new Set<Opening>();
    for (let i = 0; i < 25; i++) {
      push(sim, r1, [900, 0, 0], 0.01);
      for (const o of seenBy(sim, 0)) during.add(o);
    }
    const after = watch(sim, 3);
    expect(during.has('off_balance') || after.has('off_balance')).toBe(true);
    expect(after.has('gyro_saturated')).toBe(true);
    expect(r1.down).toBe(true);
    expect(after.has('rising')).toBe(true);
    // Down, standing flashy moves are impossible; the kip-up still has a price.
    const risk = tel(sim, 1).moveRisk!;
    expect(risk.tornado_kick).toBe(1);
    expect(risk.kip_up).toBeLessThan(1);
  }, 60_000);

  test('an opponent facing the other way is turned away; one parked by the fence is on the cage', async () => {
    sim = await makeSim({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'pylon', x: APOTHEM - 0.35, y: 0, yaw: 0 }, { systems: SYSTEMS });
    sim.seconds(0.3); // both still on the gantry, robot 1 holding its yaw with its back to robot 0
    const o = seenBy(sim, 0);
    expect(o).toContain('turned_away');
    expect(o).toContain('on_cage');
    expect(Math.abs(tel(sim, 1).facingOffDeg!)).toBeGreaterThan(150);
    expect(seenBy(sim, 1)).not.toContain('turned_away'); // robot 0 faces it squarely
    expect(seenBy(sim, 1)).not.toContain('on_cage');
  });

  test('a damaged knee shows as a weak leg on that side only', async () => {
    sim = await standoff({ design: 'haymaker', x: -0.8, y: 0, yaw: 0 }, { design: 'savate', x: 0.8, y: 0, yaw: Math.PI });
    const r1 = sim.ctx.robots[1];
    const knee = r1.joints[r1.jointIndex.get('knee_l')!];
    knee.health = 0.3;
    knee.state = 'degraded';
    sim.step(10);
    const o = seenBy(sim, 0);
    expect(o).toContain('weak_left_leg');
    expect(o).not.toContain('weak_right_leg');
  });

  test('dropped hands are a low guard; the fighting guard is not', async () => {
    const dropArms: SimSystem = {
      name: 'drop-arms',
      pre(ctx: SimContext) {
        if (!(ctx.robots[1].mem.dropArms as boolean | undefined)) return;
        const r = ctx.robots[1];
        for (const [name, q] of [['shoulder_pitch_l', 0], ['shoulder_pitch_r', 0], ['elbow_l', 0], ['elbow_r', 0]] as const) r.targets[r.jointIndex.get(name)!] = q;
      },
    };
    sim = await standoff({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'savate', x: 0.8, y: 0, yaw: Math.PI },
      [intentSystem, controlSystem, dropArms, motorSystem, damageSystem, openingsSystem]);
    expect(seenBy(sim, 0)).not.toContain('low_guard');
    sim.ctx.robots[1].mem.dropArms = true;
    sim.seconds(0.6);
    const s1 = snapshot(sim.ctx, sim.ctx.robots[1]);
    expect(Math.max(s1.fistZ!.l, s1.fistZ!.r)).toBeLessThan(s1.chinZ! - 0.2);
    expect(seenBy(sim, 0)).toContain('low_guard');
  });

  test('a strike thrown into the air: overcommitted while it flies, missed and recovering after', async () => {
    sim = await standoff({ design: 'savate', x: -1.2, y: 0, yaw: 0 }, { design: 'savate', x: 1.2, y: 0, yaw: Math.PI });
    const c1 = controllerOf(sim.ctx.robots[1])!;
    expect(c1.startSkill(SKILLS.cross!, 'head', 0.8)).toBe(true);
    const byPhase: Record<string, Set<Opening>> = { windup: new Set(), strike: new Set(), recover: new Set() };
    for (let i = 0; i < 300 && c1.skills.run; i++) {
      sim.step(5);
      const run = c1.skills.run;
      if (run) for (const o of seenBy(sim, 0)) byPhase[run.phase].add(o);
    }
    expect(byPhase.windup.has('overcommitted')).toBe(false);
    expect(byPhase.strike.has('overcommitted')).toBe(true);
    expect(byPhase.recover.has('missed_recovering')).toBe(true);
    expect(byPhase.strike.has('missed_recovering')).toBe(false);
  });

  test('a hard hit leaves the victim stunned for about 0.6 s', async () => {
    sim = await standoff({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'savate', x: 0.8, y: 0, yaw: Math.PI });
    // The damage model's impact event, as a clean cross to the head would emit it.
    sim.ctx.events.push({ kind: 'impact', pos: [0, 0, 1.4], normal: [1, 0, 0], impulseNs: 14, speed: 7, energyJ: 25, striker: 0, victim: 1, part: 'head', metal: false });
    sim.step(1);
    expect(seenBy(sim, 0)).toContain('stunned');
    expect(seenBy(sim, 1)).not.toContain('stunned'); // the striker is not the stunned one
    sim.seconds(0.7);
    expect(seenBy(sim, 0)).not.toContain('stunned');
    // Light touches never stun; the impulse rule scales with the victim's mass.
    const shot = (energyJ: number, impulseNs: number, speed = 6, part: string | null = 'head') => ({ energyJ, impulseNs, speed, part });
    expect(isStunningHit(shot(3, 2), 83)).toBe(false);
    expect(isStunningHit(shot(5, 6), 38)).toBe(true);
    expect(isStunningHit(shot(5, 6), 103)).toBe(false);
    expect(isStunningHit(shot(5, 6, 6, 'torso'), 38)).toBe(true);
    // Only a clean shot to the core: shin clashes, blocked forearms and slow body bumps rock nobody
    // (from a headless SAVATE-HAYMAKER fight: 1.2 J / 50 N·s shin, 17 J / 17 N·s forearm, 1.9 J / 14 N·s torso at 1.3 m/s).
    expect(isStunningHit(shot(1.2, 49.8, 0.7, 'shin_r'), 103)).toBe(false);
    expect(isStunningHit(shot(17.2, 17.4, 4.2, 'forearm_l'), 83)).toBe(false);
    expect(isStunningHit(shot(1.9, 14.1, 1.3, 'torso'), 103)).toBe(false);
    expect(isStunningHit(shot(25, 14, 6, null), 83)).toBe(false);
  });

  test('a low margin mid-step is a normal step, not an opening; a flipped torso has no facing', async () => {
    sim = await standoff({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'savate', x: 0.8, y: 0, yaw: Math.PI });
    const me = snapshot(sim.ctx, sim.ctx.robots[0]);
    const opp = snapshot(sim.ctx, sim.ctx.robots[1]);
    const calm = { ...opp, balance: 0.15, comVel: [0.3, 0, 0] as [number, number, number], gyro: { health: 1, saturation: 0.3 } };
    // Walking: the capture point leaves the stance foot by design.
    expect(detectOpenings(me, { ...calm, stepping: true })).not.toContain('off_balance');
    // The same margin with both feet down, or mid-step with the gyro full, is a stumble.
    expect(detectOpenings(me, { ...calm, stepping: false })).toContain('off_balance');
    expect(detectOpenings(me, { ...calm, stepping: true, gyro: { health: 1, saturation: 0.95 } })).toContain('off_balance');
    // Face-down in a get-up crouch the torso's yaw reads backwards: that is not turned away.
    const flipped = { ...opp, torsoYaw: opp.torsoYaw + Math.PI };
    expect(detectOpenings(me, flipped)).toContain('turned_away');
    expect(detectOpenings(me, { ...flipped, upright: -0.5, rising: true })).not.toContain('turned_away');
  });

  test('a southpaw stance is read from the lead foot', async () => {
    sim = await standoff({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'savate', x: 0.8, y: 0, yaw: Math.PI });
    // Robot 1 turned to face away mirrors which foot is nearer robot 0.
    const s0 = snapshot(sim.ctx, sim.ctx.robots[0]);
    const s1 = snapshot(sim.ctx, sim.ctx.robots[1]);
    expect(s0.feet!.l[0]).toBeGreaterThan(s0.feet!.r[0]); // orthodox: left foot toward +x
    const mirrored = { ...s0, feet: { l: s0.feet!.r, r: s0.feet!.l } };
    const { stanceOf } = await import('../../src/physics/openings');
    expect(stanceOf(s0, s1)).toBe('orthodox');
    expect(stanceOf(mirrored, s1)).toBe('southpaw');
  });
});

describe('moveRisk from real body states', () => {
  test('risk ordering: aerial spins riskiest, the spinning backfist safest; heavier bodies riskier in the air', async () => {
    sim = await standoff({ design: 'firecracker', x: -0.9, y: 0, yaw: 0 }, { design: 'haymaker', x: 0.9, y: 0, yaw: Math.PI });
    const light = tel(sim, 0).moveRisk!;
    const heavy = tel(sim, 1).moveRisk!;
    const standing = ['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist'] as const;
    for (const r of [light, heavy]) {
      // The tornado kick is always the riskiest standing move, the spinning backfist the safest.
      for (const m of standing) if (m !== 'tornado_kick') expect(r.tornado_kick).toBeGreaterThan(r[m]);
      for (const m of standing) if (m !== 'spinning_backfist') expect(r.spinning_backfist).toBeLessThan(r[m]);
      expect(r.jump_kick).toBeGreaterThan(r.jumping_knee);
      expect(r.spinning_back_kick).toBeGreaterThan(r.superman_punch);
      for (const v of Object.values(r)) expect(v).toBeGreaterThan(0), expect(v).toBeLessThanOrEqual(1);
    }
    // A heavy body pays for leaving the ground: its aerial kicks overtake the grounded spin.
    expect(heavy.jump_kick).toBeGreaterThan(heavy.spinning_back_kick);
    expect(light.jump_kick).toBeLessThan(light.spinning_back_kick);
    for (const m of ['tornado_kick', 'jump_kick', 'jumping_knee', 'kip_up'] as const) expect(heavy[m]).toBeGreaterThan(light[m] + 0.15);
    // Light bodies should kip up often, heavy ones rarely.
    expect(light.kip_up).toBeLessThan(0.4);
    expect(heavy.kip_up).toBeGreaterThan(0.6);
  });

  test('a worn or limp knee, a hot hip, a saturated gyro and a flat battery each raise the risk', async () => {
    sim = await standoff({ design: 'savate', x: -0.9, y: 0, yaw: 0 }, { design: 'savate', x: 0.9, y: 0, yaw: Math.PI });
    const r = sim.ctx.robots[0];
    const base = snapshot(sim.ctx, r);
    const fresh = moveRisks(base);
    const withJoint = (name: string, over: object) => ({ ...base, joints: base.joints.map((j) => (j.name === name ? { ...j, ...over } : j)) });
    const worn = moveRisks(withJoint('knee_l', { health: 0.4, state: 'ok' }));
    const limp = moveRisks(withJoint('knee_l', { health: 0.03, state: 'limp' }));
    const hot = moveRisks(withJoint('hip_pitch_r', { heat: 0.97 }));
    const sat = moveRisks({ ...base, gyro: { health: 1, saturation: 0.95 } });
    const flat = moveRisks({ ...base, battery: 0.1 });
    for (const m of ['tornado_kick', 'jump_kick', 'jumping_knee', 'spinning_back_kick'] as const) {
      expect(worn[m]).toBeGreaterThan(fresh[m]);
      expect(limp[m]).toBe(1);
      expect(hot[m]).toBeGreaterThan(fresh[m]);
      expect(sat[m]).toBeGreaterThan(fresh[m]);
      expect(flat[m]).toBeGreaterThan(fresh[m]);
    }
    // The backfist needs no legs: a limp knee does not rule it out.
    expect(limp.spinning_backfist).toBeLessThan(1);
    // Off balance (the real controller's margin while being shoved) raises every standing move.
    const pushed: number[] = [];
    for (let i = 0; i < 20; i++) {
      push(sim, r, [500, 0, 0], 0.01);
      pushed.push(tel(sim, 0).moveRisk!.spinning_back_kick);
    }
    expect(Math.max(...pushed)).toBeGreaterThan(fresh.spinning_back_kick + 0.1);
  });
});
