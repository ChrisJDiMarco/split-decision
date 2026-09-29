// Loadouts (src/robots/loadout.ts), the dexterous hand (src/robots/hands.ts) and its grip, and the
// head gaze (src/physics/systems/gaze.ts). Stock must stay byte-identical for every design.
import { describe, expect, it } from 'vitest';
import type { HandsOption, MatchSetup, RobotDesign } from '../../src/core/types';
import { controllerOf, sparringIntent } from '../../src/physics/control';
import { compileWorld } from '../../src/physics/world';
import { gazeProbe, gazeSystem } from '../../src/physics/systems/gaze';
import { gripFor, handsSystem } from '../../src/physics/systems/hands';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { SYSTEMS } from '../../src/physics/systems';
import { compileRobot, geomMass } from '../../src/robots/compile-mjcf';
import { DESIGNS, design } from '../../src/robots/designs';
import { digitJoint, fistTendonLength, gripTendon } from '../../src/robots/hands';
import { applyLoadout, handsLabel, stockHands } from '../../src/robots/loadout';
import { loadoutSim, mujoco } from './helpers';

const IDS = Object.keys(DESIGNS);
const DEG = Math.PI / 180;
const PLACE = { pos: [0.3, -0.2, 1.1] as [number, number, number], yaw: 0.4 };

function compiledText(d: RobotDesign, corner: 0 | 1): string {
  const c = compileRobot(d, corner, PLACE);
  return [c.bodyXml, c.debrisXml, c.actuatorXml, c.tendonXml, c.equalityXml, c.sensorXml, String(c.totalMassKg)].join('\n');
}

function setupFor(red: string, blue: string, hands?: HandsOption): MatchSetup {
  const f = (id: string) => ({ design: id, skin: 'factory' as const, plan: '', temperament: 1, ...(hands ? { loadout: { design: id, hands } } : {}) });
  return { fighters: [f(red), f(blue)], seed: 1, timestep: 0.001, reactionDelayS: 0 };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];

describe('applyLoadout', () => {
  for (const id of IDS) {
    it(`${id}: a stock loadout is the design itself and compiles to identical MJCF`, () => {
      const d = design(id);
      const stock = applyLoadout(d, { design: id, hands: 'stock' });
      expect(stock).toBe(d);
      expect(applyLoadout(d, undefined)).toBe(d);
      // The hands it already wears are stock too.
      expect(applyLoadout(d, { design: id, hands: stockHands(d) })).toBe(d);
      for (const c of [0, 1] as const) expect(compiledText(stock, c)).toBe(compiledText(d, c));
      expect(compileWorld(setupFor(id, 'savate', 'stock')).xml).toBe(compileWorld(setupFor(id, 'savate')).xml);
    });
  }

  it('is pure and refuses a loadout for another design', () => {
    const d = design('savate');
    const before = JSON.stringify(d);
    for (const hands of ['glove', 'knuckle', 'dexterous'] as const) applyLoadout(d, { design: 'savate', hands });
    expect(JSON.stringify(d)).toBe(before);
    expect(() => applyLoadout(d, { design: 'pylon', hands: 'glove' })).toThrow();
  });

  it('gloves a bare-fisted design and bares a gloved one', () => {
    const gloved = applyLoadout(design('savate'), { design: 'savate', hands: 'glove' });
    const fist = gloved.parts.find((p) => p.id === 'fist_l')!;
    expect(fist.geoms[0].material).toBe('glove');
    expect(fist.geoms[0].role).toBe('striker');
    expect(gloved.gloves?.color).toBeTruthy();
    expect(gloved.loadout?.hands).toBe('glove');
    expect(handsLabel(gloved)).toBe('GLOVES');
    const bare = applyLoadout(design('haymaker'), { design: 'haymaker', hands: 'knuckle' });
    const bf = bare.parts.find((p) => p.id === 'fist_r')!;
    expect(bf.geoms[0].material).toBe('ar500');
    expect(bare.gloves).toBeUndefined();
    // A bare fist is smaller than the glove it came out of.
    const gh = design('haymaker').parts.find((p) => p.id === 'fist_r')!.geoms[0];
    if (gh.shape.type !== 'box' || bf.geoms[0].shape.type !== 'box') throw new Error('box');
    expect(bf.geoms[0].shape.halfSize[0]).toBeCloseTo(gh.shape.halfSize[0] / 1.18, 6);
  });

  for (const id of IDS) {
    it(`${id}: dexterous hands add ten tendon-driven phalanges per hand and keep the servos`, () => {
      const d = design(id);
      const dex = applyLoadout(d, { design: id, hands: 'dexterous' });
      const fingers = dex.parts.filter((p) => p.tags.includes('finger'));
      expect(fingers).toHaveLength(20);
      expect(dex.parts.find((p) => p.id === 'fist_l')!.geoms[0].role).toBe('striker'); // the palm keeps the fist's id
      for (const p of fingers) {
        expect(p.joints).toHaveLength(1);
        expect(p.joints![0].passive).toBeTruthy();
        expect(geomMass(p.geoms[0])).toBeGreaterThan(0.005);
      }
      expect(dex.tendons?.map((t) => t.id)).toEqual([gripTendon('l'), gripTendon('r')]);
      expect(dex.tendons![0].joints).toHaveLength(10);
      const a = compileRobot(d, 0, PLACE), b = compileRobot(dex, 0, PLACE);
      // Servo joints and their actuators are unchanged; the two grip drives come after them.
      expect(b.joints.map((j) => j.name)).toEqual(a.joints.map((j) => j.name));
      expect(b.tendons).toHaveLength(2);
      expect(b.actuatorXml.startsWith(a.actuatorXml)).toBe(true);
      // Modern designs keep their mass within 3% (the iron age trades 5 kg AR500 fists for light hands).
      if (d.era === 'modern') expect(Math.abs(b.totalMassKg / a.totalMassKg - 1)).toBeLessThan(0.03);
      expect(handsLabel(dex)).toBe('DEXTEROUS · 5 FINGERS');
    });
  }
});

describe('dexterous hands in MuJoCo', () => {
  it('every design loads with dexterous hands, at the compiled mass', async () => {
    const mj = await mujoco();
    for (const id of IDS) {
      const world = compileWorld(setupFor(id, id, 'dexterous'));
      const model = mj.MjModel.from_xml_string(world.xml);
      expect(model.ntendon).toBe(4);
      for (const r of world.robots) {
        const root = model.body(r.parts[0].body).id as number;
        expect(model.body_subtreemass[root]).toBeCloseTo(r.totalMassKg, 1);
      }
      model.delete();
    }
  }, 60_000);

  it('the grip drive closes the hand into a fist and the springs open it', async () => {
    const mj = await mujoco();
    const world = compileWorld(setupFor('savate', 'haymaker', 'dexterous'));
    const model = mj.MjModel.from_xml_string(world.xml);
    const data = new mj.MjData(model);
    const act = model.actuator(`r0_${gripTendon('l')}_m`).id as number;
    const ten = model.tendon(`r0_${gripTendon('l')}`).id as number;
    const q = (j: string) => (data.qpos[model.jnt_qposadr[model.jnt(`r0_${j}`).id]] as number) / DEG;
    const fingers = [1, 2, 3, 4].flatMap((i) => [digitJoint('l', i, 'p'), digitJoint('l', i, 'd')]);
    const run = (ctrl: number, s: number) => {
      data.ctrl[act] = ctrl;
      for (let i = 0; i < s * 1000; i++) mj.mj_step(model, data);
    };
    run(fistTendonLength(), 0.2);
    console.log(`fist after 0.2 s: tendon ${data.ten_length[ten].toFixed(2)} / ${fistTendonLength().toFixed(2)}, joints ${fingers.map((j) => q(j).toFixed(0)).join(' ')}°, thumb ${q(digitJoint('l', 0, 'p')).toFixed(0)}°`);
    expect(Math.abs(data.ten_length[ten] / fistTendonLength() - 1)).toBeLessThan(0.05);
    for (const j of fingers) expect(q(j)).toBeGreaterThan(70);
    expect(q(digitJoint('l', 0, 'p'))).toBeGreaterThan(45);
    run(0, 0.4);
    for (const j of fingers) expect(q(j)).toBeLessThan(20);
    data.delete();
    model.delete();
  }, 60_000);

  it('grip follows what the body is doing', async () => {
    const sim = await loadoutSim({ design: 'savate', hands: 'dexterous', x: 0, y: 0, yaw: 0 }, { design: 'pylon', hands: 'dexterous', x: 1.6, y: 0, yaw: Math.PI });
    const { ctx } = sim;
    const r = ctx.robots[0];
    expect(gripFor(ctx, r, 1, 1.5)).toBe(0.35); // on the gantry: relaxed
    sim.release();
    expect(gripFor(ctx, r, 1, 1.5)).toBe(1); // opponent in range: fists up
    expect(gripFor(ctx, r, 1, 3)).toBe(0.35); // far apart: relaxed
    expect(gripFor(ctx, r, 0.3, 1.5)).toBe(0); // falling: open to brace
    r.intent = { tactic: 'clinch', target: 'head', aggression: 0.5, confidence: 0.5, source: 'fallback' };
    expect(gripFor(ctx, r, 1, 1.5)).toBe(0.55); // clinch: hook the fingers
    r.koReason = 'down';
    expect(gripFor(ctx, r, 1, 1.5)).toBe(0); // out cold: slack
    sim.dispose();
  }, 60_000);

  it('a dexterous SAVATE and HAYMAKER stand and trade strikes for 20 s without breaking', async () => {
    const sim = await loadoutSim({ design: 'savate', hands: 'dexterous', x: -0.8, y: 0, yaw: 0 }, { design: 'haymaker', hands: 'dexterous', x: 0.8, y: 0, yaw: Math.PI }, 7);
    const { ctx } = sim;
    sim.step(500);
    sim.release();
    let hits = 0, fingerHits = 0, maxQvel = 0;
    const grips = new Set<number>();
    const fingerGeoms = new Set(ctx.robots.flatMap((r) => [...r.parts.values()].filter((p) => p.id.startsWith('digit_')).flatMap((p) => p.geoms)));
    sim.step(20_000, () => {
      if (ctx.tick % 500 === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
      for (const e of ctx.events) if (e.kind === 'impact' && e.striker !== null && e.victim !== null && e.striker !== e.victim) hits++;
      if (ctx.tick % 20 === 0) {
        for (let k = 0; k < ctx.model.nv; k++) maxQvel = Math.max(maxQvel, Math.abs(ctx.data.qvel[k]));
        for (const r of ctx.robots) grips.add((r.mem.hands as { grip: number[] }).grip[0]);
        const con = ctx.data.ncon as number;
        if (con) {
          const cs = ctx.data.contact;
          for (let i = 0; i < con; i++) {
            const c = cs.get(i);
            if (fingerGeoms.has(c.geom1) || fingerGeoms.has(c.geom2)) fingerHits++;
            c.delete();
          }
          cs.delete();
        }
      }
    });
    const tel = buildTelemetry(ctx, ctx.robots[0], SYSTEMS);
    console.log(`20 s dexterous: ${hits} robot-on-robot impacts, finger contacts sampled ${fingerHits}, grips ${[...grips].join('/')}, max |qvel| ${maxQvel.toFixed(1)}, telemetry parts ${tel.parts.length}`);
    expect(Number.isFinite(maxQvel)).toBe(true);
    expect(maxQvel).toBeLessThan(400);
    expect(hits).toBeGreaterThan(0);
    expect(grips.has(1)).toBe(true);
    expect(tel.grip).toBeTruthy();
    expect(tel.parts.some((p) => p.id.startsWith('digit_'))).toBe(false); // phalanges ride on the palm
    sim.dispose();
  }, 120_000);
});

describe('head gaze', () => {
  it('tracks an opponent standing off to the side with saccade-like fixations', async () => {
    const sim = await loadoutSim({ design: 'savate', x: 0, y: 0, yaw: 0 }, { design: 'pylon', x: 2.2, y: 1.4, yaw: Math.PI });
    const { ctx } = sim;
    const r = ctx.robots[0];
    const opp = controllerOf(ctx.robots[1]);
    if (opp) opp.enabled = false; // a still target
    sim.step(500);
    sim.release();
    const errs: number[] = [], offs: number[] = [];
    let track = 0, n = 0, fixations = 0, lastCmd = NaN;
    sim.step(3000, () => {
      const p = gazeProbe(ctx, r)!;
      if (p.cmd.yaw !== lastCmd) fixations++;
      lastCmd = p.cmd.yaw;
      if (ctx.tick % 20 !== 0 || ctx.time < 1.5) return;
      n++;
      if (p.mode === 'track') track++;
      errs.push(p.neckErr / DEG);
      offs.push(Math.abs(p.desiredYaw - (ctx.data.qpos[r.joints[r.jointIndex.get('neck_yaw')!].qadr] as number)) / DEG);
    });
    const g = buildTelemetry(ctx, r, SYSTEMS).gaze!;
    const oppHead = ctx.robots[1].parts.get('head')!.body * 3;
    const xp = ctx.data.xpos;
    console.log(`gaze: track ${track}/${n}, fixations ${fixations} in 3 s, neck vs command p50 ${pct(errs, 0.5).toFixed(1)}° p90 ${pct(errs, 0.9).toFixed(1)}°, neck vs live bearing p50 ${pct(offs, 0.5).toFixed(1)}° p90 ${pct(offs, 0.9).toFixed(1)}°`);
    expect(track / n).toBeGreaterThan(0.9);
    expect(pct(errs, 0.9)).toBeLessThan(4);
    expect(pct(offs, 0.9)).toBeLessThan(9);
    expect(g.mode).toBe('track');
    expect(Math.hypot(g.point[0] - xp[oppHead], g.point[1] - xp[oppHead + 1])).toBeLessThan(0.3);
    sim.dispose();
  }, 60_000);

  it('scans before the bell, snaps to a threat, aims at the target, looks down when down, lets go when out', async () => {
    const sim = await loadoutSim({ design: 'firecracker', x: 0, y: 0, yaw: 0 }, { design: 'savate', x: 1.4, y: 0.3, yaw: Math.PI });
    const { ctx } = sim;
    const [me, opp] = ctx.robots;
    for (const r of ctx.robots) { const c = controllerOf(r); if (c) c.enabled = false; }
    const settle = () => sim.step(10);
    sim.step(300);
    expect(gazeProbe(ctx, me)!.mode).toBe('scan');
    sim.release();
    settle();
    expect(gazeProbe(ctx, me)!.mode).toBe('track');
    opp.skill = 'cross';
    opp.windup = 0.6;
    settle();
    expect(gazeProbe(ctx, me)!.mode).toBe('threat');
    opp.skill = 'stance';
    opp.windup = 0;
    me.intent = { tactic: 'hook', target: 'torso', aggression: 0.9, confidence: 0.9, source: 'jev', flourish: true };
    me.skill = 'hook';
    me.windup = 0.4;
    settle();
    expect(gazeProbe(ctx, me)!.mode).toBe('aim');
    expect(buildTelemetry(ctx, me, SYSTEMS).gaze!.lock).toBeGreaterThan(0.9); // a flourish locks on
    me.skill = 'stance';
    me.windup = 0;
    me.down = true;
    settle();
    expect(gazeProbe(ctx, me)!.mode).toBe('down');
    expect(buildTelemetry(ctx, me, SYSTEMS).gaze!.point[2]).toBe(0);
    const neck = me.jointIndex.get('neck_yaw')!;
    expect(Math.abs(me.targets[neck])).toBeGreaterThan(0.01); // looking at the planting hand
    me.koReason = 'down';
    settle();
    expect(me.targets[neck]).toBe(me.design.stance.neck_yaw ?? 0); // the (idle) controller's target, untouched
    expect(buildTelemetry(ctx, me, SYSTEMS).gaze!.lock).toBe(0);
    sim.dispose();
  }, 60_000);

  it('gaze and grip cost under 15 µs per robot-step', async () => {
    const sim = await loadoutSim({ design: 'savate', hands: 'dexterous', x: -0.8, y: 0, yaw: 0 }, { design: 'haymaker', hands: 'dexterous', x: 0.8, y: 0, yaw: Math.PI });
    const { ctx } = sim;
    sim.release();
    sim.step(200);
    const N = 5000;
    let t = 0;
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      gazeSystem.pre!(ctx);
      handsSystem.pre!(ctx);
      t += performance.now() - a;
      sim.step(1);
    }
    const us = (t * 1000) / N / 2;
    console.log(`gaze + hands: ${us.toFixed(2)} µs per robot-step`);
    expect(us).toBeLessThan(15);
    sim.dispose();
  }, 60_000);
});
