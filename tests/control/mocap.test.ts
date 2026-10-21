// The mocap tracking layer (src/physics/control/mocap): playback never asks the motors for more
// than they have, the get-up plan and the skill table match the libraries, and in the sim the
// modern fighters get up from the canvas (a damaged waist included), punch to the head and
// celebrate a knockout on their feet.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/core/protocol';
import { controllerOf } from '../../src/physics/control';
import { GETUP_PLAN } from '../../src/physics/control/mocap/getup-plan';
import { mocapSet, SPEED_FRACTION } from '../../src/physics/control/mocap/library';
import { MotionPlayer } from '../../src/physics/control/mocap/player';
import { ENGINE_PROCEDURAL_KICKS, MOCAP_KICKS, mocapSkill } from '../../src/physics/control/mocap/skills';
import { SKILLS } from '../../src/physics/control/skills';
import type { RobotRuntime } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
import { intent, makeSim, pelvisPos, torsoUp, type Sim } from './helpers';

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;
const GETUP_S = 12; // two attempts (a first one can lose the feet in the crouch); a fight counts 20
const STAY_UP_S = 3;
const UP_UPRIGHT = 0.8; // torso up-axis z
const UP_HEIGHT = 0.8; // × stance pelvis height
// Root orientations [w, x, y, z] for a body laid on the canvas.
const LYING: Record<string, [number, number, number, number]> = {
  'face down': [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 0],
  'on its back': [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0],
};

/** Robot 0 alone on the canvas (robot 1 parked far off, its controller off). */
async function alone(design: string): Promise<{ sim: Sim; r: RobotRuntime }> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: 'haymaker', x: 6, y: 0, yaw: Math.PI });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  sim.seconds(0.3);
  sim.release(0);
  return { sim, r: sim.ctx.robots[0] };
}

/** Lay robot 0 on the canvas and time its get-up: seconds to the 'getup' event, and standing after. */
function layDownAndRise(sim: Sim, r: RobotRuntime, quat: [number, number, number, number]): { took: number; standing: boolean; refalls: number } {
  const { ctx } = sim;
  const c = controllerOf(r)!;
  const a = r.rootQadr;
  ctx.data.qpos[a + 2] = 0.3;
  for (let i = 0; i < 4; i++) ctx.data.qpos[a + 3 + i] = quat[i];
  ctx.mj.mj_forward(ctx.model, ctx.data);
  const t0 = ctx.time;
  let upAt = -1, refalls = 0;
  sim.seconds(GETUP_S + STAY_UP_S + 3, () => {
    for (const e of ctx.events as SimEvent[]) {
      if (e.kind === 'getup' && e.corner === 0 && upAt < 0) upAt = ctx.time;
      if (e.kind === 'fall' && e.corner === 0 && upAt >= 0) refalls++;
    }
    ctx.events.length = 0;
  });
  const standing = !r.down && torsoUp(ctx, r) > UP_UPRIGHT && pelvisPos(ctx, r)[2] > UP_HEIGHT * c.stance.pelvisHeight;
  return { took: upAt >= 0 ? upAt - t0 : Infinity, standing, refalls };
}

describe('mocap playback and tables', () => {
  it('never plays a move faster than its joints can follow', async () => {
    for (const design of MODERN) {
      const { sim, r } = await alone(design);
      const set = mocapSet(r)!;
      expect(set).not.toBeNull();
      const player = new MotionPlayer(set, r.joints.length);
      for (const label of ['jab', 'hook', 'getup_back'] as const) {
        const move = set.byLabel.get(label)![0];
        player.play(move, { speed: 2.5 });
        let steps = 0;
        while (!player.done && steps < 20_000) {
          const limit = player.limitAt(player.tau);
          player.step(0.001);
          expect(player.rate).toBeLessThanOrEqual(Math.max(limit, 0.05) + 1e-9);
          expect(player.rate).toBeLessThanOrEqual(2.5 + 1e-9);
          steps++;
        }
        expect(player.done).toBe(true);
        // Joint velocities stay near the motors' usable speed (the rate table is per frame and
        // eases over a few frames, so allow a margin).
        player.play(move, { speed: 2.5 });
        let worst = 0;
        while (!player.done) {
          player.step(0.001);
          r.joints.forEach((j, i) => { worst = Math.max(worst, Math.abs(player.qd[i]) / (SPEED_FRACTION * j.motor.noLoadSpeedRadS)); });
        }
        expect(worst).toBeLessThan(1.5);
      }
      sim.dispose();
    }
  }, 120_000);

  it('plans get-ups only from moves the design has', async () => {
    for (const [design, plan] of Object.entries(GETUP_PLAN)) {
      const { sim, r } = await alone(design);
      const set = mocapSet(r)!;
      const ids = new Set(set.lib.moves.map((m) => m.id));
      for (const entries of Object.values(plan)) for (const e of entries ?? []) expect(ids.has(e.id)).toBe(true);
      sim.dispose();
    }
  }, 120_000);

  it('throws punches from the clips at the procedural ranges and keeps the procedural kicks', async () => {
    const { sim, r } = await alone('savate');
    const set = mocapSet(r)!;
    const c = controllerOf(r)!;
    for (const id of ['jab', 'cross', 'hook'] as const) {
      const def = mocapSkill(set, id)!;
      expect(def.clip).toBeDefined();
      expect(def.range(c.geo)).toEqual(SKILLS[id]!.range(c.geo));
      expect(c.skillFor(id)?.clip).toBeDefined();
    }
    for (const id of ['front_kick', 'low_kick', 'head_kick'] as const) {
      expect(mocapSkill(set, id)).toBeNull();
      // On the balance engine the mocap kicks play where they pass the kick drill (MOCAP_KICKS.engine,
      // ENGINE_PROCEDURAL_KICKS); the legacy path keeps the procedural kicks.
      const engineKick = c.engine && MOCAP_KICKS.engine && !ENGINE_PROCEDURAL_KICKS.savate?.includes(id) ? mocapSkill(set, id, true) : null;
      if (engineKick) expect(c.skillFor(id)).toBe(engineKick);
      else expect(c.skillFor(id)).toBe(SKILLS[id]);
    }
    sim.dispose();
  }, 60_000);
});

describe('mocap get-ups', () => {
  for (const design of ['savate', 'pylon'] as const) {
    for (const [how, quat] of Object.entries(LYING)) {
      it(`${design} laid ${how} is up within ${GETUP_S} s and still standing ${STAY_UP_S} s later`, async () => {
        const { sim, r } = await alone(design);
        sim.seconds(0.5);
        const res = layDownAndRise(sim, r, quat);
        console.log(`${design} ${how}: up after ${res.took.toFixed(1)} s, standing ${res.standing}, refalls ${res.refalls}`);
        expect(res.took).toBeLessThanOrEqual(GETUP_S);
        expect(res.standing).toBe(true);
        sim.dispose();
      }, 120_000);
    }
  }

  it('rises on the hips when the waist is too weak to lift the torso', async () => {
    const { sim, r } = await alone('savate');
    sim.seconds(0.5);
    const waist = r.joints[r.jointIndex.get('waist_pitch')!];
    waist.health = 0.3;
    waist.state = 'degraded';
    const res = layDownAndRise(sim, r, LYING['face down']);
    console.log(`savate, degraded waist: up after ${res.took.toFixed(1)} s, standing ${res.standing}, refalls ${res.refalls}`);
    expect(res.took).toBeLessThanOrEqual(GETUP_S);
    expect(res.standing).toBe(true);
    sim.dispose();
  }, 120_000);
});

describe('mocap strikes and the victory', () => {
  it('lands jabs on a standing guard and reaches the head', async () => {
    const sim = await makeSim({ design: 'pylon', x: -0.35, y: 0, yaw: 0 }, { design: 'savate', x: 0.35, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
    sim.seconds(0.3);
    sim.release(0);
    sim.release(1);
    const { ctx } = sim;
    const r = ctx.robots[0];
    const c = controllerOf(r)!;
    sim.seconds(0.4);
    r.intent = intent('jab', 'head', 0.8);
    let head = 0, falls = 0;
    sim.seconds(10, () => {
      for (const e of ctx.events as SimEvent[]) {
        if (e.kind === 'impact' && e.striker === 0 && e.victim === 1 && e.part === 'head') head++;
        if (e.kind === 'fall' && e.corner === 0) falls++;
      }
      ctx.events.length = 0;
    });
    const { thrown, landed } = c.skills.stats;
    console.log(`pylon jabs: thrown ${thrown}, landed ${landed}, head contacts ${head}, falls ${falls}`);
    expect(thrown).toBeGreaterThanOrEqual(4);
    expect(landed).toBeGreaterThanOrEqual(0.7 * thrown);
    expect(head).toBeGreaterThanOrEqual(1);
    expect(falls).toBe(0);
    sim.dispose();
  }, 120_000);

  it('celebrates a knockout on its feet', async () => {
    const { sim, r } = await alone('pylon');
    const { ctx } = sim;
    const c = controllerOf(r)!;
    sim.seconds(1);
    ctx.robots[1].koReason = 'down';
    let celebrating = 0, falls = 0, top = -Infinity;
    sim.seconds(6, () => {
      for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === 0) falls++;
      ctx.events.length = 0;
      if (r.skill === 'victory') celebrating += ctx.dt;
      const s = c.lastSense!;
      top = Math.max(top, s.fists.l[2] - s.torsoPos[2], s.fists.r[2] - s.torsoPos[2]);
    });
    console.log(`pylon victory: celebrating ${celebrating.toFixed(1)} of 6 s, falls ${falls}, highest fist ${top.toFixed(2)} m above the torso`);
    expect(celebrating).toBeGreaterThan(5);
    expect(falls).toBe(0);
    expect(top).toBeGreaterThan(0.3);
    sim.dispose();
  }, 120_000);
});
