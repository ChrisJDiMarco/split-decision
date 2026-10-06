// Physical damage effects (docs/design/strike-power.md §4.7): flecks by shell material, and joint
// failures shown at the joint by what failed.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SimEvent } from '../../src/core/protocol';
import { ContactSystem } from '../../src/render/vfx/contact';
import { makeRng, toWorld } from '../../src/render/vfx/coords';
import { DebrisSystem, type DebrisKind } from '../../src/render/vfx/debris';
import { routeEvent } from '../../src/render/vfx/event-router';
import { FlashSystem } from '../../src/render/vfx/flash';
import { SmokeSystem } from '../../src/render/vfx/smoke';
import { SparkSystem } from '../../src/render/vfx/sparks';

type Impact = Extract<SimEvent, { kind: 'impact' }>;
type Joint = Extract<SimEvent, { kind: 'joint' }>;

function systems() {
  const rng = makeRng(9);
  const fx = {
    sparks: new SparkSystem(rng),
    contact: new ContactSystem(),
    flash: new FlashSystem(),
    debris: new DebrisSystem(rng),
    smoke: new SmokeSystem(rng),
    com: (_c: 0 | 1, out: THREE.Vector3) => out.set(0, 1, 0),
  };
  return { fx, rng };
}

/** Pieces of each debris kind on screen. */
function pieces(debris: DebrisSystem): Record<string, number> {
  const species = (debris as unknown as { species: Array<{ kind: DebrisKind; pieces: unknown[] }> }).species;
  const out: Record<string, number> = {};
  for (const sp of species) out[sp.kind] = (out[sp.kind] ?? 0) + sp.pieces.length;
  return out;
}

const strike = (over: Partial<Impact> = {}): SimEvent => ({
  kind: 'impact', pos: [0, 0, 1.4], normal: [1, 0, 0], impulseNs: 30, speed: 6, energyJ: 25,
  striker: 1, victim: 0, part: 'torso', metal: false, workJ: 40, peakForceN: 6000, strikerPart: 'fist_r', clean: true, push: false, ...over,
});

const failure = (over: Partial<Joint> = {}): SimEvent => ({
  kind: 'joint', corner: 0, joint: 'elbow_l', health: 0.6, state: 'degraded', cause: 'gear', failure: 'strip', severity: 1.5, pos: [0.2, 0.1, 1.1], role: 'victim', ...over,
});

describe('shell flecks', () => {
  test('a cracked carbon panel throws dark fibre', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ dent: { part: 'torso', mode: 'crack', depthM: 0.003, radiusM: 0.05, cracked: true } }), fx, rng);
    expect(pieces(fx.debris).fibre).toBeGreaterThan(0);
    expect(fx.sparks.alive).toBe(0);
  });
  test('a gouged UHMW shell sheds pale shavings', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ dent: { part: 'torso', mode: 'gouge', depthM: 0.006, radiusM: 0.05, cracked: false } }), fx, rng);
    expect(pieces(fx.debris).shaving).toBeGreaterThan(0);
  });
  test('polycarbonate whitens with a pale puff; a crack through it also throws flakes', () => {
    const quiet = systems();
    routeEvent(strike({ dent: { part: 'torso', mode: 'whiten', depthM: 0.004, radiusM: 0.04, cracked: false } }), quiet.fx, quiet.rng);
    const cracked = systems();
    routeEvent(strike({ dent: { part: 'torso', mode: 'whiten', depthM: 0.012, radiusM: 0.06, cracked: true } }), cracked.fx, cracked.rng);
    expect(pieces(quiet.fx.debris).flake ?? 0).toBe(0);
    expect(pieces(cracked.fx.debris).flake).toBeGreaterThan(0);
    expect(cracked.fx.smoke.alive).toBeGreaterThan(0);
  });
  test('a hit that left no mark throws none of them', () => {
    const { fx, rng } = systems();
    routeEvent(strike(), fx, rng);
    const p = pieces(fx.debris);
    expect((p.fibre ?? 0) + (p.shaving ?? 0) + (p.flake ?? 0)).toBe(0);
  });
});

describe('joint failures at the joint', () => {
  test('a stripped gear sprays sparks and chips at the joint, with a flash', () => {
    const { fx, rng } = systems();
    routeEvent(failure(), fx, rng);
    expect(fx.sparks.alive).toBeGreaterThan(0);
    expect(pieces(fx.debris).chip).toBeGreaterThan(0);
    // The sparks start at the joint's anchor, not the robot's centre.
    const pos = (fx.sparks as unknown as { s: { pos: Float32Array } }).s.pos; // simulation state (iPos uploads on update)
    const at = toWorld([0.2, 0.1, 1.1], new THREE.Vector3());
    expect(new THREE.Vector3(pos[0], pos[1], pos[2]).distanceTo(at)).toBeLessThan(0.05);
  });
  test('a bent shaft crunches out flecks and grit, no sparks', () => {
    const { fx, rng } = systems();
    routeEvent(failure({ cause: 'bearing', failure: 'bend', bendAxis: [0, 1, 0] }), fx, rng);
    expect(fx.sparks.alive).toBe(0);
    expect(pieces(fx.debris).chip).toBeGreaterThan(0);
    expect(fx.smoke.alive).toBeGreaterThan(0);
  });
  test('a hyperextension snaps with a bright flash', () => {
    const { fx, rng } = systems();
    routeEvent(failure({ cause: 'hyperextension', failure: 'hyperextension' }), fx, rng);
    expect(fx.contact.alive).toBeGreaterThan(0);
    expect(fx.sparks.alive).toBeGreaterThan(0);
  });
  test('a struck drive housing sparks and puffs dark smoke', () => {
    const { fx, rng } = systems();
    routeEvent(failure({ cause: 'housing', failure: 'fault', state: 'ok', health: 0.97 }), fx, rng);
    expect(fx.sparks.alive).toBeGreaterThan(0);
    expect(fx.smoke.alive).toBeGreaterThan(0);
  });
  test('thermal limp, lost parts, quiet wear and events without a position show nothing here', () => {
    for (const e of [
      failure({ cause: 'thermal', failure: 'wear', state: 'limp' }),
      failure({ cause: 'detach', failure: 'detach', state: 'limp' }),
      failure({ failure: 'wear', state: 'ok' }),
      { kind: 'joint', corner: 0, joint: 'knee_l', health: 0, state: 'limp' } as SimEvent,
    ]) {
      const { fx, rng } = systems();
      routeEvent(e, fx, rng);
      expect(fx.sparks.alive + fx.smoke.alive + fx.debris.total + fx.contact.alive).toBe(0);
    }
  });
});
