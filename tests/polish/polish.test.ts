// Move polish (docs/design/move-polish.md §9.1): the rollout world is the game's physics, snapshots
// restore bit-identically, nothing but the gyro couple ever touches the body, PolishedPlayer with zero
// corrections IS today's MotionPlayer tracking, the stored format round-trips, mirroring is exact, and
// every stored polish replays from its file exactly and is refused once stale.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchSetup } from '../../src/core/types';
import { addVelocityFeedforward } from '../../src/physics/control/feedforward';
import { mocapSet } from '../../src/physics/control/mocap/library';
import { MotionPlayer } from '../../src/physics/control/mocap/player';
import { compileWorld } from '../../src/physics/world';
import {
  decodeDq, decodeGyro, decodeNominal, decodePolish, decodeRates, decodeTrack, encodeDq, encodeGyro, encodeNominal, encodeRates, encodeTrack,
  hashString, NOMINAL_STRIDE, quantizeNominal, quantizeTrack, TRACK_STRIDE, type PolishJson,
} from '../../src/robots/motions/polish/format';
import { CANVAS_CONTACT, compatHash, PHYSICS_OPTION } from '../../src/robots/motions/polish/hash';
import { polishProblem, readPolishFromDisk } from '../../src/robots/motions/polish/load';
import { CONTROL_DT, PolishedPlayer, type PolishPlan } from '../../src/robots/motions/polish/player';
import { QUANT } from '../../src/robots/motions/types';
import { TODAY } from '../../tools/polish/plan';
import { newTrace, TRACE_STRIDE } from '../../tools/polish/rollout';
import { MoveSession } from '../../tools/polish/session';
import { POLISHED_DIR, readIndex, sourceHashes } from '../../tools/polish/store';
import { honestyViolation, massChecksum, physicsStep, readSense, restore, rolloutXml } from '../../tools/polish/world';

const DESIGN = 'savate';
const MOVE = 'cross.13_17.1024';

function setup(): MatchSetup {
  return {
    fighters: [{ design: DESIGN, skin: 'factory', plan: '', temperament: 1 }, { design: 'haymaker', skin: 'factory', plan: '', temperament: 1 }],
    seed: 1, timestep: 0.001, reactionDelayS: 0,
  };
}

describe('the rollout world is the game world', () => {
  it('uses the option block and canvas of src/physics/world.ts verbatim', () => {
    const game = compileWorld(setup()).xml;
    expect(game).toContain(PHYSICS_OPTION);
    expect(game).toContain(CANVAS_CONTACT);
    const one = rolloutXml(DESIGN).xml;
    expect(one).toContain(PHYSICS_OPTION);
    expect(one).toContain(CANVAS_CONTACT);
  });

  it('restores a snapshot bit-identically (INTEGRATION state + the motor model, battery, gyro and rng)', async () => {
    const ses = await MoveSession.create(DESIGN, MOVE);
    const plan = ses.player.plan;
    const start = ses.settle(plan);
    const a = newTrace(), b = newTrace();
    const qpos = () => Array.from(ses.w.ctx.data.qpos as Float64Array);
    const ra = ses.roll(start, plan, { untilTau: 0.5, maxWallS: 2, feedback: false, trace: a, snapAtTau: 0.25 });
    const endA = qpos();
    ses.roll(start, plan, { untilTau: 0.5, maxWallS: 2, feedback: false, trace: b });
    expect(a.n).toBe(b.n);
    expect(Array.from(a.data.subarray(0, a.n * TRACE_STRIDE))).toEqual(Array.from(b.data.subarray(0, b.n * TRACE_STRIDE)));
    // Resuming from the mid-run snapshot ends exactly where the uninterrupted run ended.
    expect(ra.snap).not.toBeNull();
    ses.roll({ snap: ra.snap!, clock: ra.snapPlayer! }, plan, { untilTau: 0.5, maxWallS: 2, feedback: false });
    expect(qpos()).toEqual(endA);
  }, 60_000);

  it('never touches the body but through the motors and the gyro couple', async () => {
    const ses = await MoveSession.create('firecracker', 'tornado_kick.135_07.0179');
    const plan: PolishPlan = { ...ses.player.plan, gyroFF: new Float64Array((ses.spec.segments + 1) * 2).fill(20), track: ses.track, trackFrames: ses.track.length / TRACK_STRIDE, fb: { ankleD: 1.5, ankleV: 1.5, hipTilt: 0.3, gyroD: 1, gyroV: 1, gyroL: 0, clamp: 0.15 } };
    const mass0 = massChecksum(ses.w);
    const start = ses.settle(plan);
    let bad: string | null = null, ticks = 0;
    ses.roll(start, plan, {
      untilTau: 0.8, maxWallS: 2, feedback: true,
      onTick: () => {
        ticks++;
        bad ??= honestyViolation(ses.w);
      },
    });
    expect(ticks).toBeGreaterThan(100);
    expect(bad).toBeNull();
    expect(massChecksum(ses.w)).toBe(mass0);
    expect(ses.w.ctx.eqActive[ses.w.ctx.eqIndex(ses.w.r.compiled.gantryWeld)]).toBe(0);
    expect(ses.w.ctx.model.opt.timestep).toBe(0.001);
  }, 60_000);
});

describe('PolishedPlayer', () => {
  it("with zero Δq, no feedback and today's rates reproduces MotionPlayer tracking exactly", async () => {
    // Two identical worlds from the same settled start: one driven by MotionPlayer + the tracker's
    // velocity feed-forward, the other by PolishedPlayer's plain plan.
    const a = await MoveSession.create(DESIGN, MOVE);
    const b = await MoveSession.create(DESIGN, MOVE);
    const start = a.settle(a.player.plan);
    restore(b.w, start.snap);
    const set = mocapSet(b.w.r)!;
    const today = TODAY[a.spec.kind];
    const mp = new MotionPlayer(set, b.w.r.joints.length);
    mp.play(a.spec.move, { speed: today.speed, mask: today.mask, limitScale: today.limitScale });
    const pa = a.player;
    pa.plan = a.player.plan;
    pa.start(a.place);
    restore(a.w, start.snap);
    const tg = new Float64Array(b.w.r.joints.length);
    let maxDiff = 0, ticks = 0;
    while (!mp.done && ticks < 3000) {
      // Control tick in both worlds (same parity as the game: every second physics step).
      const sa = readSense(a.w);
      a.w.r.targets.set(pa.tick(CONTROL_DT, sa));
      mp.step(CONTROL_DT);
      tg.set(mp.q);
      addVelocityFeedforward(b.w.r, tg, mp.qd);
      b.w.r.targets.set(tg);
      for (let i = 0; i < tg.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.w.r.targets[i] - b.w.r.targets[i]));
      for (let k = 0; k < 2; k++) {
        physicsStep(a.w);
        physicsStep(b.w);
      }
      ticks++;
    }
    expect(ticks).toBeGreaterThan(100);
    expect(maxDiff).toBe(0);
    const qa = Array.from(a.w.ctx.data.qpos as Float64Array), qb = Array.from(b.w.ctx.data.qpos as Float64Array);
    expect(qa).toEqual(qb);
  }, 60_000);

  it('mirrors the clip and its correction through the library mirror map', async () => {
    const ses = await MoveSession.create(DESIGN, MOVE);
    const lib = ses.w.lib;
    const nl = lib.joints.length;
    const dq = new Float64Array((ses.spec.segments + 3) * nl).map((_, i) => Math.sin(i * 1.7) * 0.1);
    const plan: PolishPlan = { ...ses.player.plan, dq };
    const orth = new PolishedPlayer(ses.w.joints, lib.mirror, ses.spec.move, plan);
    const mirr = new PolishedPlayer(ses.w.joints, lib.mirror, ses.spec.move, plan);
    const sense = readSense(ses.w);
    const noFF = { ...sense, kp: new Float64Array(sense.kp.length) }; // no velocity feed-forward
    orth.start({ x: 0, y: 0, yaw: 0 }, false);
    mirr.start({ x: 0, y: 0, yaw: 0 }, true);
    for (let k = 0; k < 150; k++) {
      const to = orth.tick(CONTROL_DT, noFF), tm = mirr.tick(CONTROL_DT, noFF);
      ses.w.joints.forEach((j, i) => {
        const c = j.lib;
        const ip = ses.w.joints.findIndex((x) => x.lib === lib.mirror.perm[c]);
        expect(tm[i]).toBeCloseTo(lib.mirror.sign[c] * to[ip], 9);
      });
    }
  }, 60_000);
});

describe('stored format', () => {
  it('round-trips every channel at its quantization', () => {
    const dq = Float64Array.from({ length: 23 * 20 }, (_, i) => Math.sin(i) * 0.3);
    const back = decodeDq(encodeDq(dq));
    for (let i = 0; i < dq.length; i++) expect(Math.abs(back[i] - dq[i])).toBeLessThanOrEqual(QUANT.angle / 2 + 1e-9);
    const rates = Float64Array.from({ length: 90 }, (_, i) => 0.5 + i / 50);
    const rb = decodeRates(encodeRates(rates));
    for (let i = 0; i < rates.length; i++) expect(Math.abs(rb[i] - rates[i])).toBeLessThanOrEqual(5e-4 + 1e-9);
    const g = Float64Array.from({ length: 30 }, (_, i) => (i - 15) * 7.3);
    const gb = decodeGyro(encodeGyro(g));
    for (let i = 0; i < g.length; i++) expect(Math.abs(gb[i] - g[i])).toBeLessThanOrEqual(0.005 + 1e-9);
    // Nominal and track: a quantized array survives the round trip unchanged.
    const nom = Float64Array.from({ length: NOMINAL_STRIDE * 40 }, (_, i) => Math.cos(i) * 0.8);
    quantizeNominal(nom);
    const nb = decodeNominal(encodeNominal(nom));
    for (let i = 0; i < nom.length; i++) expect(nb[i]).toBeCloseTo(nom[i], 6);
    const tr = Float64Array.from({ length: TRACK_STRIDE * 40 }, (_, i) => Math.sin(i * 0.3) * 0.9);
    quantizeTrack(tr);
    const tb = decodeTrack(encodeTrack(tr));
    for (let i = 0; i < tr.length; i++) expect(tb[i]).toBeCloseTo(tr[i], 6);
  });

  it('hashes the robot as built and refuses failed or mismatched polishes', () => {
    expect(compatHash(DESIGN)).toBe(compatHash(DESIGN));
    expect(compatHash(DESIGN)).not.toBe(compatHash('haymaker'));
    expect(hashString('a')).not.toBe(hashString('b'));
    const fake = { status: 'polished', design: DESIGN, hash: compatHash(DESIGN) } as PolishJson;
    expect(polishProblem(fake)).toBeNull();
    expect(polishProblem({ ...fake, hash: '0000000000000000' })).toMatch(/stale/);
    expect(polishProblem({ ...fake, status: 'failed', reason: 'nominal falls' })).toMatch(/failed/);
  });
});

describe('stored polishes', () => {
  const designs = existsSync(POLISHED_DIR) ? readdirSync(POLISHED_DIR).filter((d) => existsSync(`${POLISHED_DIR}/${d}/index.json`)) : [];

  it('were made on the sources the game runs now (motors, gyro, player), or are stale', () => {
    const now = sourceHashes();
    const stale: string[] = [];
    for (const d of designs) {
      const ix = readIndex(d);
      for (const [f, h] of Object.entries(ix.sources)) if (now[f] !== h) stale.push(`${d}: ${f} changed since the polish`);
    }
    // A stale polish must be re-run (tools/polish/run.ts) before it ships; the runtime refuses a hash mismatch.
    expect(stale).toEqual([]);
  });

  it('replay bit-identically from the stored file', async () => {
    let checked = 0;
    for (const d of designs) {
      const ix = JSON.parse(readFileSync(`${POLISHED_DIR}/${d}/index.json`, 'utf8')) as { moves: Record<string, { status: string }> };
      const id = Object.keys(ix.moves).find((m) => ix.moves[m].status === 'polished');
      if (!id) continue;
      const json = readPolishFromDisk(d, id)!;
      if (polishProblem(json)) continue; // stale: the hash test above reports it
      const pm = decodePolish(json);
      const ses = await MoveSession.create(d, id);
      const plan: PolishPlan = {
        knotS: pm.knotS, segments: pm.segments, tailS: pm.tailS, rates: pm.rates, dq: pm.dq, libJoints: pm.nj, gyroFF: pm.gyroFF,
        fb: pm.fb, deadband: pm.deadband, nominal: pm.nominal, nominalSamples: pm.nominalSamples, track: pm.track, trackFrames: pm.trackFrames,
      };
      const runs = [newTrace(), newTrace()];
      for (const t of runs) ses.roll(ses.settle(plan), plan, { untilTau: ses.spec.move.duration + pm.tailS, maxWallS: 20, feedback: true, trace: t });
      expect(runs[0].n).toBe(runs[1].n);
      expect(Array.from(runs[0].data.subarray(0, runs[0].n * TRACE_STRIDE))).toEqual(Array.from(runs[1].data.subarray(0, runs[1].n * TRACE_STRIDE)));
      // And it is the nominal the file stores (COM, sampled at 250 Hz on the player's clock).
      const t0 = runs[0];
      let worst = 0;
      for (let i = 0; i < t0.n; i++) {
        const k = Math.round(t0.data[i * TRACE_STRIDE] * 250);
        if (k >= pm.nominalSamples) break;
        worst = Math.max(worst, Math.abs(t0.data[i * TRACE_STRIDE + 33] - pm.nominal[k * NOMINAL_STRIDE]));
      }
      expect(worst).toBeLessThan(0.01);
      checked++;
    }
    if (!designs.length) expect(checked).toBe(0);
  }, 300_000);
});
