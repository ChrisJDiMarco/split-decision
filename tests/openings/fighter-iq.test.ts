// Fighter IQ computed from real MuJoCo states: guard gaps from real poses, the weak-spot map
// (damage, design, guard, what lands), feint bites from scripted opponent reactions, and the habit
// counts that come out of them. Feints are scripted on the controller (a real strike windup pulled
// at 70%), the same shape the control contract asks the body for.
import { afterEach, describe, expect, test } from 'vitest';
import type { FeintRead, RobotTelemetry } from '../../src/core/protocol';
import { controllerOf, controlSystem } from '../../src/physics/control';
import { SKILLS } from '../../src/physics/control/skills';
import { damageSystem } from '../../src/physics/damage';
import { guardRead, openingsSystem, snapshot } from '../../src/physics/openings';
import type { SimContext, SimSystem } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
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

async function standoff(a: Placement, b: Placement, systems: readonly SimSystem[] = SYSTEMS): Promise<Sim> {
  const s = await makeSim(a, b, { systems });
  s.seconds(0.3);
  s.release(0);
  s.release(1);
  s.seconds(1.0);
  return s;
}

const pair = (red: string, blue: string, gap = 0.75) => standoff({ design: red, x: -gap, y: 0, yaw: 0 }, { design: blue, x: gap, y: 0, yaw: Math.PI });

/** Robot 1 drops its hands while mem.dropArms is set. */
const dropArms: SimSystem = {
  name: 'drop-arms',
  pre(ctx: SimContext) {
    const r = ctx.robots[1];
    if (!(r.mem.dropArms as boolean | undefined)) return;
    for (const [name, q] of [['shoulder_pitch_l', 0], ['shoulder_pitch_r', 0], ['elbow_l', 0], ['elbow_r', 0]] as const) r.targets[r.jointIndex.get(name)!] = q;
  },
};
const WITH_DROP = [intentSystem, controlSystem, dropArms, motorSystem, damageSystem, openingsSystem];

describe('guard gaps from real poses', () => {
  test.each(['firecracker', 'savate', 'haymaker', 'pylon'])('%s: a fighting guard covers every line; dropped hands open the head', async (d) => {
    sim = await standoff({ design: d, x: -0.8, y: 0, yaw: 0 }, { design: d, x: 0.8, y: 0, yaw: Math.PI }, WITH_DROP);
    const read = () => guardRead(snapshot(sim!.ctx, sim!.ctx.robots[1]), snapshot(sim!.ctx, sim!.ctx.robots[0]));
    expect(read()).toEqual({ center: true, left: true, right: true, body: true });
    sim.ctx.robots[1].mem.dropArms = true;
    sim.seconds(0.6);
    expect(read()).toMatchObject({ center: false, left: false, right: false });
    // ... and the weak-spot map ranks his open head.
    const head = tel(sim, 0).weakSpots!.find((w) => w.zone === 'head');
    expect(head?.reasons.some((r) => r.kind === 'guard_open')).toBe(true);
  }, 60_000);

  test('a cross still out: his right side and his body are open, then covered again', async () => {
    sim = await pair('savate', 'savate', 1.2);
    const c1 = controllerOf(sim.ctx.robots[1])!;
    expect(c1.startSkill(SKILLS.cross!, 'head', 0.8)).toBe(true);
    const seen = { rightOpen: false, bodyOpen: false };
    for (let i = 0; i < 300 && c1.skills.run; i++) {
      sim.step(5);
      const g = guardRead(snapshot(sim.ctx, sim.ctx.robots[1]), snapshot(sim.ctx, sim.ctx.robots[0]))!;
      if (c1.skills.run?.phase === 'strike') { seen.rightOpen ||= !g.right; seen.bodyOpen ||= !g.body; }
    }
    expect(seen).toEqual({ rightOpen: true, bodyOpen: true });
    sim.seconds(0.5);
    expect(guardRead(snapshot(sim.ctx, sim.ctx.robots[1]), snapshot(sim.ctx, sim.ctx.robots[0]))).toMatchObject({ right: true, body: true });
  }, 60_000);
});

describe('weak-spot map from real states', () => {
  test('a failing knee ranks first with its health; the other leg does not', async () => {
    sim = await pair('savate', 'haymaker');
    const r1 = sim.ctx.robots[1];
    const knee = r1.joints[r1.jointIndex.get('knee_l')!];
    knee.health = 0.4;
    knee.state = 'degraded';
    sim.step(4);
    const spots = tel(sim, 0).weakSpots!;
    expect(spots[0].zone).toBe('left_leg');
    expect(spots[0].reasons[0]).toMatchObject({ kind: 'joint_failing', part: 'knee_l', value: 0.4 });
    const right = spots.find((w) => w.zone === 'right_leg');
    expect(right === undefined || right.score < spots[0].score - 0.3).toBe(true);
    // HAYMAKER's X12 hips are the roster's slowest: both legs carry it, as a design weakness.
    expect(spots[0].reasons.some((r) => r.kind === 'slow_legs') || spots[0].reasons.length === 3).toBe(true);
  }, 60_000);

  test('design weaknesses: PYLON a narrow base and a glass jaw for HAYMAKER; FIRECRACKER light for anyone big', async () => {
    sim = await pair('haymaker', 'pylon');
    const onPylon = tel(sim, 0).weakSpots!;
    const reasons = (z: string) => onPylon.find((w) => w.zone === z)?.reasons.map((r) => r.kind) ?? [];
    expect(reasons('head')).toContain('glass_jaw');
    expect([...reasons('torso'), ...reasons('left_leg'), ...reasons('right_leg')]).toContain('narrow_base');
    // PYLON on HAYMAKER: a heavier opponent with a thick UHMW head, no glass jaw.
    expect(tel(sim, 1).weakSpots!.find((w) => w.zone === 'head')?.reasons.map((r) => r.kind) ?? []).not.toContain('glass_jaw');
    sim.dispose();
    sim = await pair('savate', 'firecracker');
    const onBantam = tel(sim, 0).weakSpots!;
    expect(onBantam.flatMap((w) => w.reasons.map((r) => r.kind))).toContain('light_frame');
    expect(onBantam.find((w) => w.zone === 'head')?.reasons.map((r) => r.kind)).toContain('glass_jaw');
  }, 60_000);

  test('a cracked head shell and shots that keep landing move the head up the ranking', async () => {
    sim = await pair('savate', 'savate');
    const before = tel(sim, 0).weakSpots!.find((w) => w.zone === 'head')?.score ?? 0;
    sim.ctx.robots[1].parts.get('head')!.hp = 0.35;
    for (let i = 0; i < 3; i++) {
      sim.ctx.events.push({ kind: 'impact', pos: [0.7, 0, 1.5], normal: [1, 0, 0], impulseNs: 10, speed: 6, energyJ: 22, striker: 0, victim: 1, part: 'head', metal: false });
      sim.seconds(0.4);
    }
    const head = tel(sim, 0).weakSpots!.find((w) => w.zone === 'head')!;
    expect(head.score).toBeGreaterThan(before + 0.4);
    expect(head.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(['armor_cracked', 'keeps_landing']));
    expect(head.reasons.find((r) => r.kind === 'keeps_landing')!.value).toBe(3);
    expect(tel(sim, 0).weakSpots![0].zone).toBe('head');
  }, 60_000);
});

// ---------------------------------------------------------------- feints and bites

type React = (s: Sim) => void;

/**
 * Robot 0 shows a real strike windup and pulls it at 70% (the feint). `onShow` runs once, 60 ms into
 * the windup (a reaction to the telegraph); `onPull` once, right after the pull. Returns robot 0's
 * reads once the bite window has closed.
 */
function feint(s: Sim, skill: 'cross' | 'jab' | 'low_kick', opts: { onShow?: React; onPull?: React; pull?: boolean } = {}): FeintRead[] {
  const c0 = controllerOf(s.ctx.robots[0])!;
  expect(c0.startSkill(SKILLS[skill]!, skill === 'low_kick' ? 'left_leg' : 'head', 0.6)).toBe(true);
  let pulled = false, shown = false;
  for (let i = 0; i < 500; i++) {
    s.step(2);
    const run = c0.skills.run;
    if (!shown && run && run.t > 0.06) { shown = true; opts.onShow?.(s); }
    if (!pulled && opts.pull !== false && run && run.phase === 'windup' && run.t >= 0.7 * run.durations.windup) {
      c0.skills.cancel(null);
      pulled = true;
      opts.onPull?.(s);
    }
  }
  return tel(s, 0).reads ?? [];
}

const start = (skill: 'guard' | 'jab' | 'cross') => (s: Sim) => { controllerOf(s.ctx.robots[1])!.startSkill(SKILLS[skill]!, 'head', skill === 'cross' ? 0.2 : 0.8); };

describe('bites read in physics from scripted reactions', () => {
  test('no reaction: a read with no bite; a strike that commits is no feint at all', async () => {
    sim = await pair('savate', 'pylon');
    const reads = feint(sim, 'cross');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ seq: 1, level: 'high', limb: 'arm', skill: 'cross', bit: false, reactions: [], deliberate: true });
    expect(feint(sim, 'jab', { pull: false })).toHaveLength(1); // thrown for real: nothing new
  }, 60_000);

  test('a windup pulled while its mind asked for a strike is no feint: his attack caused it, no read', async () => {
    sim = await pair('savate', 'pylon');
    // A strike intent (the body pulls it for a reflex or a switch to defence), and he throws.
    const intent = { tactic: 'jab', target: 'head', aggression: 0.5, confidence: 1, source: 'fallback' } as const;
    sim.ctx.robots[0].intent = { ...intent };
    expect(feint(sim, 'cross', { onShow: start('jab') })).toEqual([]);
    // The same pull with a feint asked for is a feint, and his jab is his answer.
    sim.seconds(0.8);
    sim.ctx.robots[0].intent = { ...intent, tactic: 'feint' };
    const reads = feint(sim, 'cross', { onShow: start('jab') });
    expect(reads[0]).toMatchObject({ deliberate: true, bit: true });
    expect(reads[0].reactions).toContain('countered');
  }, 60_000);

  test.each([
    ['guard', 'covered', { onShow: start('guard') }],
    ['a counter jab', 'countered', { onShow: start('jab') }],
    ['stepping away', 'retreated', { onPull: (s: Sim) => push(s, s.ctx.robots[1], [700, 0, 0], 0.15) }],
  ] as const)('he answers with %s: %s', async (_what, reaction, opts) => {
    sim = await pair('savate', 'pylon');
    const reads = feint(sim, 'cross', opts);
    expect(reads).toHaveLength(1);
    expect(reads[0].bit).toBe(true);
    expect(reads[0].reactions).toContain(reaction);
  }, 60_000);

  test('a bite is published right after it is seen; no bite only once the window has closed', async () => {
    sim = await pair('savate', 'pylon');
    let pulledAt = 0;
    const bit = feint(sim, 'cross', { onShow: start('guard'), onPull: (s) => { pulledAt = s.ctx.time; } });
    expect(bit[0].time - pulledAt).toBeLessThan(0.12);
    sim.seconds(0.8);
    const quiet = feint(sim, 'cross', { onPull: (s) => { pulledAt = s.ctx.time; } });
    expect(quiet[1].bit).toBe(false);
    expect(quiet[1].time - pulledAt).toBeGreaterThanOrEqual(0.5);
  }, 60_000);

  test('he pulls his own shot when he sees it coming: flinched', async () => {
    sim = await pair('savate', 'pylon');
    start('cross')(sim); // his own windup is on its way ...
    const reads = feint(sim, 'jab', { onShow: (s) => { controllerOf(s.ctx.robots[1])!.skills.cancel(null); } });
    expect(reads[0].reactions).toContain('flinched');
  }, 60_000);

  test('a pulled low kick is a low feint; guarding against it is a bite at that level', async () => {
    sim = await pair('savate', 'pylon');
    const reads = feint(sim, 'low_kick', { onShow: start('guard') });
    expect(reads[0]).toMatchObject({ level: 'low', limb: 'leg', skill: 'low_kick', bit: true });
  }, 60_000);

  test('habits: he guards against 3 of 4 high feints → "bites high 3 of 4"', async () => {
    sim = await pair('savate', 'pylon');
    for (let i = 0; i < 4; i++) {
      feint(sim, 'cross', i === 1 ? {} : { onShow: start('guard') });
      sim.seconds(0.8); // his guard runs out
    }
    const t = tel(sim, 0);
    expect(t.reads!.map((r) => r.bit)).toEqual([true, false, true, true]);
    expect(t.habits).toContainEqual({ kind: 'bites', level: 'high', n: 3, of: 4 });
    expect(tel(sim, 1).habits ?? []).toEqual([]); // what robot 1 knows about robot 0: nothing yet
  }, 120_000);
});

describe('cost', () => {
  test('the 4 ms watchers and the richer telemetry stay cheap', async () => {
    sim = await pair('savate', 'haymaker');
    const N = 4000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      sim.ctx.tick = Math.ceil(sim.ctx.tick / 4) * 4 + 4 * i; // every call is a sampling tick
      openingsSystem.post!(sim.ctx);
    }
    const perSampleUs = ((performance.now() - t0) / N) * 1000;
    const out = tel(sim, 0);
    const t1 = performance.now();
    for (let i = 0; i < N; i++) {
      sim.ctx.tick++;
      openingsSystem.telemetry!(sim.ctx, sim.ctx.robots[0], out);
      openingsSystem.telemetry!(sim.ctx, sim.ctx.robots[1], out);
    }
    const perFrameUs = ((performance.now() - t1) / N) * 1000;
    console.log(`fighter IQ: watchers ${perSampleUs.toFixed(1)} µs per 4 ms sample (${(perSampleUs / 4).toFixed(2)} µs per step); telemetry ${perFrameUs.toFixed(1)} µs per frame (both)`);
    expect(perSampleUs / 4).toBeLessThan(3); // under ~3% of the ~95 µs step
    expect(perFrameUs).toBeLessThan(100);
  }, 60_000);
});
