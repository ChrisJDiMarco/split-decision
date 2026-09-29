// Hit feel: strike strength bands, contact marks, glove puffs vs metal sparks, canvas dust.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SimEvent } from '../../src/core/protocol';
import { ContactSystem } from '../../src/render/vfx/contact';
import { makeRng } from '../../src/render/vfx/coords';
import { DebrisSystem } from '../../src/render/vfx/debris';
import { routeEvent } from '../../src/render/vfx/event-router';
import { FlashSystem } from '../../src/render/vfx/flash';
import { footDustPuffs, HIT, hitStrength, strikeStrength } from '../../src/render/vfx/scaling';
import { SmokeSystem } from '../../src/render/vfx/smoke';
import { SparkSystem } from '../../src/render/vfx/sparks';

type Impact = Extract<SimEvent, { kind: 'impact' }>;

function systems() {
  const rng = makeRng(4);
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

/** A gloved strike to the head: electric-roster numbers (not metal on metal). */
const strike = (over: Partial<Impact> = {}): SimEvent => ({
  kind: 'impact', pos: [0, 0, 1.6], normal: [1, 0, 0], impulseNs: 20, speed: 5, energyJ: 20,
  striker: 1, victim: 0, part: 'head', metal: false, ...over,
});

describe('hit strength', () => {
  test('grows with energy, saturates at 1, and ignores impulse from slow shoves', () => {
    expect(hitStrength(2, 5, 1.5)).toBeLessThan(HIT.MIN);
    expect(hitStrength(20, 20, 5)).toBeGreaterThan(hitStrength(8, 10, 4));
    expect(hitStrength(5000, 500, 9)).toBe(1);
    // A 60 N·s clinch shove at 0.8 m/s is not a hit; the same impulse on a 4 m/s strike is.
    expect(hitStrength(3, 60, 0.8)).toBeLessThan(HIT.MIN);
    expect(hitStrength(3, 60, 4)).toBeGreaterThan(HIT.RING);
  });
  test('measured electric-roster p50 hits are quiet and the top hits reach the hit-stop band', () => {
    expect(hitStrength(3, 10, 1.8)).toBeLessThan(HIT.RING); // p50: ~3 J, 10 N·s
    expect(hitStrength(24, 20, 4.5)).toBeGreaterThanOrEqual(HIT.HIT_STOP); // top ~5%
    expect(hitStrength(78, 68, 7.2)).toBeGreaterThanOrEqual(HIT.PULSE); // the hardest measured
  });
});

describe('clean strikes', () => {
  // Measured 2026-09-29: iron-age getup rolls (both down) kicking shins/feet at 60-115 J, and a
  // foot stepping on the other's foot at 26 J / 3.5 m/s, all reached the hit-stop band.
  const up = [{ down: false }, { down: false }];
  test('a real strike keeps its strength', () => {
    const e = strike() as Impact;
    expect(strikeStrength(e, up)).toBe(hitStrength(e.energyJ, e.impulseNs, e.speed));
    expect(strikeStrength(e)).toBe(hitStrength(e.energyJ, e.impulseNs, e.speed));
  });
  test('feet treading on each other, a ground scramble and self-contacts are not strikes', () => {
    expect(strikeStrength(strike({ part: 'foot_l', energyJ: 26, impulseNs: 23, speed: 3.5 }) as Impact, up)).toBe(0);
    expect(strikeStrength(strike({ part: 'shin_l', energyJ: 100, impulseNs: 168, speed: 4 }) as Impact, [{ down: true }, { down: true }])).toBe(0);
    expect(strikeStrength(strike({ striker: 0, victim: 0 }) as Impact, up)).toBe(0);
    expect(strikeStrength(strike({ striker: null }) as Impact, up)).toBe(0);
  });
  test('a standing striker hitting a downed opponent still counts', () => {
    expect(strikeStrength(strike() as Impact, [{ down: true }, { down: false }])).toBeGreaterThan(HIT.RING);
  });
  test('a ground scramble gets no strike marks, but metal legs clashing still spark', () => {
    const down = [{ down: true }, { down: true }];
    const soft = systems();
    routeEvent(strike({ part: 'shin_l', energyJ: 80, impulseNs: 40, speed: 5 }), soft.fx, soft.rng, down);
    expect(soft.fx.contact.alive).toBe(0);
    expect(soft.fx.smoke.alive).toBe(0);
    expect(soft.fx.debris.total).toBe(0);
    const metal = systems();
    routeEvent(strike({ part: 'shin_l', energyJ: 80, impulseNs: 40, speed: 5, metal: true }), metal.fx, metal.rng, down);
    expect(metal.fx.sparks.alive).toBeGreaterThan(0);
    expect(metal.fx.contact.alive).toBe(0);
  });
});

describe('strike marks', () => {
  test('a tiny touch produces nothing at all', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ energyJ: 1.5, impulseNs: 6, speed: 1.2 }), fx, rng);
    expect(fx.smoke.alive).toBe(0);
    expect(fx.contact.alive).toBe(0);
    expect(fx.sparks.alive).toBe(0);
    expect(fx.debris.total).toBe(0);
  });
  test('a gloved hit bursts a soft puff with a ring and a surface flash, and never sparks', () => {
    const { fx, rng } = systems();
    routeEvent(strike(), fx, rng);
    expect(fx.smoke.alive).toBeGreaterThan(2);
    expect(fx.contact.ringCount).toBe(1);
    expect(fx.contact.flashCount).toBe(1);
    expect(fx.sparks.alive).toBe(0);
  });
  test('a light but real hit gets only the puff', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ energyJ: 5, impulseNs: 8, speed: 3 }), fx, rng);
    expect(fx.smoke.alive).toBeGreaterThan(0);
    expect(fx.contact.alive).toBe(0);
  });
  test('bare metal on metal throws a spark spray instead of a puff', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ metal: true, energyJ: 40, impulseNs: 40 }), fx, rng);
    expect(fx.sparks.alive).toBeGreaterThan(0);
    expect(fx.smoke.alive).toBe(0);
    expect(fx.contact.ringCount).toBe(1);
  });
  test('only the heaviest hits fling flecks', () => {
    const light = systems();
    routeEvent(strike({ energyJ: 15 }), light.fx, light.rng);
    expect(light.fx.debris.total).toBe(0);
    const heavy = systems();
    routeEvent(strike({ energyJ: 55, impulseNs: 60, speed: 6.5 }), heavy.fx, heavy.rng);
    expect(heavy.fx.debris.total).toBeGreaterThan(1);
  });
  test('rings and flashes expand, fade and are gone within half a second', () => {
    const { fx, rng } = systems();
    routeEvent(strike({ energyJ: 60, impulseNs: 60 }), fx, rng);
    const shape = () => (fx.contact.object.children[0] as THREE.Mesh).geometry.getAttribute('iShape').array as Float32Array;
    fx.contact.update(0.001);
    const r0 = shape()[0];
    fx.contact.update(0.08);
    expect(shape()[0]).toBeGreaterThan(r0);
    for (let i = 0; i < 30; i++) fx.contact.update(1 / 60);
    expect(fx.contact.alive).toBe(0);
  });
  test('surface flashes stay small and fade near the lens', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0.3);
    camera.updateMatrixWorld();
    const c = new ContactSystem(camera);
    c.flash(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(1, 0, 0), 1, 0.13);
    expect(c.flashCount).toBe(0); // 0.3 m from the lens: faded out entirely
    const far = new ContactSystem();
    far.flash(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(1, 0, 0), 1, 0.13);
    far.update(0.001);
    const shape = (far.object.children[1] as THREE.Mesh).geometry.getAttribute('iShape').array as Float32Array;
    expect(shape[0]).toBeLessThan(0.2); // radius, metres
    expect(shape[2]).toBeLessThanOrEqual(1); // alpha capped
  });
});

describe('canvas dust', () => {
  const floor = (over: Partial<Impact>): SimEvent => ({
    kind: 'impact', pos: [0.4, 0, 0.05], normal: [0, 0, -1], impulseNs: 40, speed: 3, energyJ: 40,
    striker: null, victim: 0, part: 'torso', metal: false, ...over,
  });
  test('a hard foot plant raises a little dust, a body slam a cloud and a dust ring', () => {
    const step = systems();
    routeEvent(floor({ part: 'foot_l', speed: 3.3 }), step.fx, step.rng);
    const slam = systems();
    routeEvent(floor({ part: 'torso', speed: 4.6 }), slam.fx, slam.rng);
    expect(step.fx.smoke.alive).toBeGreaterThan(0);
    expect(slam.fx.smoke.alive).toBeGreaterThan(step.fx.smoke.alive);
    expect(step.fx.contact.ringCount).toBe(0);
    expect(slam.fx.contact.ringCount).toBe(1);
  });
  test('ordinary footfalls (below the 2.5 m/s event threshold) raise nothing', () => {
    expect(footDustPuffs(2)).toBe(0);
    expect(footDustPuffs(4.5)).toBeGreaterThan(footDustPuffs(2.6));
  });
});
