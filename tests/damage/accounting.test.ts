// Impact accounting (docs/design/strike-power.md §3.2): the measured absorbed work, one strike = one
// episode over its first 30 ms, and post-strike pushing tagged as pushes.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/core/protocol';
import { damageState, detachPart } from '../../src/physics/damage';
import { DAMAGE_TUNING, OVERLOAD_ARM_TAIL_S } from '../../src/physics/damage/constants';
import type { SimContext } from '../../src/physics/sim-context';
import { drain, makeRig, ofKind, step } from './helpers';

/** Drops a robot off its gantry and sends it flying: root at (x, 0, z), velocity (vx, 0, 0). */
function launch(ctx: SimContext, corner: 0 | 1, x: number, vx: number): void {
  const r = ctx.robots[corner];
  ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.data.qpos[r.rootQadr] = x;
  ctx.data.qvel[r.rootDadr] = vx;
  ctx.mj.mj_forward(ctx.model, ctx.data);
}

describe('impact accounting', () => {
  it('the absorbed work of a dropped part is the kinetic energy it brings (trapezoid integral)', () => {
    const ctx = makeRig();
    step(ctx, 300);
    drain(ctx);
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    expect(detachPart(ctx, st, head, [0, 0, 0])).toBe(true);
    // Lift the loose head 0.6 m above the canvas, at rest, and let it fall.
    const debris = head.part.debrisBody!;
    const jnt = ctx.model.body_jntadr[debris];
    const qa = ctx.model.jnt_qposadr[jnt];
    const da = ctx.model.jnt_dofadr[jnt];
    ctx.data.qpos[qa] = 0;
    ctx.data.qpos[qa + 1] = 2.5;
    ctx.data.qpos[qa + 2] = 0.6;
    ctx.data.qpos.set([1, 0, 0, 0], qa + 3);
    for (let k = 0; k < 6; k++) ctx.data.qvel[da + k] = 0;
    ctx.mj.mj_forward(ctx.model, ctx.data);
    const z0 = ctx.data.xipos[debris * 3 + 2];
    let vz = 0;
    let first: Extract<SimEvent, { kind: 'impact' }> | undefined;
    step(ctx, 600, () => {
      if (!first) vz = Math.min(vz, ctx.data.qvel[da + 2]);
      first ??= ofKind(ctx.events, 'impact').find((e) => e.victim === null || e.part === null);
    });
    const mass = ctx.model.body_mass[debris];
    const ke = 0.5 * mass * vz * vz;
    console.info(`[work] loose head ${mass.toFixed(2)} kg from ${z0.toFixed(2)} m: landing KE ${ke.toFixed(1)} J, measured work ${first?.workJ?.toFixed(1)} J, presentation energy ${first?.energyJ.toFixed(1)} J`);
    expect(first).toBeDefined();
    expect(first!.workJ!).toBeGreaterThan(0.8 * ke);
    expect(first!.workJ!).toBeLessThan(1.25 * ke);
  });

  it('one strike is one event: every contact in its first 30 ms sums into it, and the push after is tagged', () => {
    const ctx = makeRig();
    step(ctx, 300);
    drain(ctx);
    ctx.released = true;
    launch(ctx, 1, -1.25, -2.5); // Striker flies at the Bruiser: arms, gloves, torso all touch
    const robotHits: Array<Extract<SimEvent, { kind: 'impact' }> & { tick: number }> = [];
    step(ctx, 500, () => {
      for (const e of ofKind(ctx.events, 'impact')) if (e.striker !== null && e.victim !== null) robotHits.push({ ...e, tick: ctx.tick });
      ctx.events.length = 0;
    });
    const strikes = robotHits.filter((e) => !e.push);
    const pushes = robotHits.filter((e) => e.push);
    console.info(`[accounting] ${strikes.length} strike events (${strikes.map((e) => `${e.part} ${e.impulseNs.toFixed(0)} N·s ${e.speed.toFixed(1)} m/s`).join(' | ')}), ${pushes.length} push events (${pushes.reduce((a, e) => a + e.impulseNs, 0).toFixed(0)} N·s)`);
    expect(strikes.length).toBeGreaterThan(0);
    // Strikes are whole episodes: two strikes by the same robot are at least a window apart, and a
    // strike inside another's push tail arrived at striking speed.
    const window = Math.round(DAMAGE_TUNING.strikeWindowS / ctx.dt);
    const tail = Math.round(DAMAGE_TUNING.pushTailS / ctx.dt);
    for (let k = 1; k < strikes.length; k++) {
      const prev = strikes[k - 1], cur = strikes[k];
      if (prev.striker !== cur.striker) continue;
      expect(cur.tick - prev.tick).toBeGreaterThanOrEqual(window);
      if (cur.tick - prev.tick < window + tail) expect(cur.speed).toBeGreaterThanOrEqual(DAMAGE_TUNING.newStrikeSpeed);
    }
    // The first strike carries its whole first 30 ms: more impulse than any single fragment after it.
    expect(strikes[0].impulseNs).toBeGreaterThan(Math.max(0, ...pushes.map((e) => e.impulseNs)) * 0.5);
  });

  it('pushes arm no joints: only strikes load the joint channels', () => {
    const ctx = makeRig();
    step(ctx, 300);
    drain(ctx);
    ctx.released = true;
    launch(ctx, 1, -1.25, -2.5);
    const st = damageState(ctx);
    let lastStrikeArmEnd = -1;
    let armedPastStrikes = 0;
    step(ctx, 500, () => {
      for (const e of ofKind(ctx.events, 'impact')) {
        if (e.striker !== null && e.victim !== null && !e.push) lastStrikeArmEnd = ctx.tick + Math.round(OVERLOAD_ARM_TAIL_S / ctx.dt) + 1;
      }
      ctx.events.length = 0;
      for (const rd of st.robots) for (const info of rd.parts.values()) {
        if (info.armedUntil > Math.max(lastStrikeArmEnd, ctx.tick + 2 * Math.round(DAMAGE_TUNING.strikeWindowS / ctx.dt) + 5)) armedPastStrikes++;
      }
    });
    expect(armedPastStrikes).toBe(0);
  });

  it("a push ends the strike's arm tail: no joint is loaded while the post-strike push is on", () => {
    // A 1 ms strike window and no fresh strikes: the robot's next contacts, a few ms after its first,
    // are a push that starts inside the strike's arm tail (OVERLOAD_ARM_TAIL_S).
    const saved = { w: DAMAGE_TUNING.strikeWindowS, s: DAMAGE_TUNING.newStrikeSpeed };
    DAMAGE_TUNING.strikeWindowS = 0.001;
    DAMAGE_TUNING.newStrikeSpeed = 100;
    try {
      const ctx = makeRig();
      step(ctx, 300);
      drain(ctx);
      ctx.released = true;
      launch(ctx, 1, -1.25, -5);
      const st = damageState(ctx);
      let pushTicks = 0;
      let armedDuringPush = 0;
      step(ctx, 300, () => {
        ctx.events.length = 0;
        const lastStrikeEnd = Math.max(...st.strikeEnd);
        const push = st.pushes.some((g) => g && !g.done && g.startTick <= ctx.tick && g.startTick >= lastStrikeEnd);
        if (!push || st.strikes.some((g) => g && !g.done)) return;
        pushTicks++;
        for (const rd of st.robots) for (const info of rd.parts.values()) if (info.armedUntil >= ctx.tick) armedDuringPush++;
      });
      expect(pushTicks).toBeGreaterThan(0);
      expect(armedDuringPush).toBe(0);
    } finally {
      DAMAGE_TUNING.strikeWindowS = saved.w;
      DAMAGE_TUNING.newStrikeSpeed = saved.s;
    }
  });
});
