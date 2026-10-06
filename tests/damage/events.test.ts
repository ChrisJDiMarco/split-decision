import { describe, expect, it } from 'vitest';
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

describe('impact events', () => {
  it('a robot slammed back-first into the fence emits a cage event', () => {
    const ctx = makeRig();
    step(ctx, 300);
    drain(ctx);
    ctx.released = true;
    launch(ctx, 0, -3.65, -3.5); // Bruiser faces +x: it backs into the -x panel
    step(ctx, 400);
    const events = drain(ctx);
    const cage = ofKind(events, 'cage');
    const fenceHits = ofKind(events, 'impact').filter((e) => e.victim === 0 && e.striker === null && e.pos[0] < -3.8);
    console.info(`[cage] ${cage.length} cage events, speeds ${cage.map((e) => e.speed.toFixed(2)).join(', ')}; ` +
      `fence impacts ${fenceHits.map((e) => `${e.part}:${e.impulseNs.toFixed(0)} N·s`).join(', ')}`);
    expect(cage.length).toBeGreaterThan(0);
    expect(cage[0].corner).toBe(0);
    expect(cage[0].speed).toBeGreaterThanOrEqual(1.5);
    expect(fenceHits.length).toBeGreaterThan(0);
    expect(fenceHits.every((e) => !e.metal)).toBe(true); // vinyl-coated chain link: no sparks
    expect(fenceHits[0].normal[0]).toBeGreaterThan(0.5); // the fence pushes the robot back toward the center
  });

  it('robot-on-robot hits name the moving robot as striker and spark on steel', () => {
    const ctx = makeRig();
    step(ctx, 300);
    drain(ctx);
    ctx.released = true;
    launch(ctx, 1, -1.25, -2.5); // Striker flies at the Bruiser, who hangs still on its gantry
    step(ctx, 300);
    const hits = ofKind(drain(ctx), 'impact').filter((e) => e.victim !== null && e.striker !== null);
    console.info(`[robot hits] ${hits.map((e) => `${e.striker}→${e.victim}:${e.part} ${e.impulseNs.toFixed(0)} N·s ${e.speed.toFixed(1)} m/s ${e.energyJ.toFixed(0)} J${e.metal ? ' sparks' : ''}`).join(' | ')}`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ striker: 1, victim: 0, push: false });
    expect(hits.some((e) => e.metal)).toBe(true);
    // The measured contact: absorbed work, peak force and the striking part ride on the event.
    expect(hits[0].workJ).toBeGreaterThan(0);
    expect(hits[0].peakForceN).toBeGreaterThan(0);
    expect(hits[0].strikerPart).toBeTruthy();
    // A slow body check into the Bruiser's 4 mm AR500 stays elastic: hardened shells shrug it off.
    expect(ctx.robots[0].parts.get(hits[0].part!)!.damage).toBe(0);
    expect(hits[0].dent).toBeUndefined();
  });
});
