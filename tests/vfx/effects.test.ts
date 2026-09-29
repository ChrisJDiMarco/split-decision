import { setSetting } from '../../src/core/settings';
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three/webgpu';
import type { PartTelemetry, RobotTelemetry, SimEvent, WorldMeta } from '../../src/core/protocol';
import { makeRng, toWorld } from '../../src/render/vfx/coords';
import { DebrisSystem } from '../../src/render/vfx/debris';
import { PARTICLES_PER_LITRE, TelemetryEmitters } from '../../src/render/vfx/emitters';
import { routeEvent } from '../../src/render/vfx/event-router';
import { FlashSystem } from '../../src/render/vfx/flash';
import { FallbackOil } from '../../src/render/vfx/oil/oil-fallback';
import { chipCount, debrisCount, dustPuffs, leakJetSpeed, smokeDarkness, smokeRate, sparkCount } from '../../src/render/vfx/scaling';
import { SmokeSystem } from '../../src/render/vfx/smoke';
import { SparkSystem, blackbody } from '../../src/render/vfx/sparks';

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 2, 6);

function part(id: string, over: Partial<PartTelemetry> = {}): PartTelemetry {
  return { id, hp: 1, smoke: 0, heat: 0, attached: true, leak: 0, ...over };
}

function robot(corner: 0 | 1, parts: PartTelemetry[], pressure = 1): RobotTelemetry {
  return {
    corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
    battery: 1, gyroHealth: 1, gyroSaturation: 0, hydraulicPressure: { arms: pressure }, skill: 'idle',
    skillPhase: 0, windup: 0, parts, joints: [], damageTotal: 0, intent: null,
  };
}

describe('scaling', () => {
  test('harder hits throw more sparks, never below the tap threshold', () => {
    expect(sparkCount(1)).toBe(0);
    expect(sparkCount(60)).toBeLessThan(sparkCount(900));
    expect(sparkCount(1e6)).toBeLessThanOrEqual(320);
  });
  test('debris and chips need real energy', () => {
    expect(debrisCount(100)).toBe(0);
    expect(debrisCount(2000)).toBeGreaterThan(0);
    expect(chipCount(10)).toBe(0);
  });
  test('smoke goes from off, to light haze, to thick black', () => {
    expect(smokeRate(0)).toBe(0);
    expect(smokeRate(0.3)).toBeLessThan(smokeRate(1));
    expect(smokeDarkness(0.2)).toBe(0);
    expect(smokeDarkness(1)).toBe(1);
  });
  test('oil jets harder with pressure (Bernoulli)', () => {
    expect(leakJetSpeed(1, 0.5)).toBeGreaterThan(leakJetSpeed(0.25, 0.5));
    expect(leakJetSpeed(0, 0.5)).toBeLessThan(0.5);
  });
  test('dust only on real slams', () => {
    expect(dustPuffs(0.5)).toBe(0);
    expect(dustPuffs(5)).toBeGreaterThan(dustPuffs(2));
  });
});

describe('coordinates', () => {
  test('physics z-up maps to world y-up like stage.physicsRoot', () => {
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld();
    const expected = new THREE.Vector3(1, 2, 3).applyMatrix4(root.matrixWorld);
    const got = toWorld([1, 2, 3]);
    expect(got.distanceTo(expected)).toBeLessThan(1e-9);
  });
});

describe('sparks', () => {
  test('sparks fall, bounce on the canvas and burn out', () => {
    const sparks = new SparkSystem(makeRng(1));
    const n = sparks.burst(new THREE.Vector3(0, 1.5, 0), 900);
    expect(n).toBeGreaterThan(50);
    let minY = Infinity;
    for (let i = 0; i < 60; i++) {
      sparks.update(1 / 60);
      const pos = sparks.object.geometry.getAttribute('iPos').array as Float32Array;
      for (let k = 0; k < sparks.alive; k++) minY = Math.min(minY, pos[k * 3 + 1]);
    }
    expect(minY).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 180; i++) sparks.update(1 / 60);
    expect(sparks.alive).toBe(0);
  });
  test('hot steel glows white-yellow, cools to a dim red', () => {
    const hot = blackbody(1, new THREE.Color());
    const cool = blackbody(0.25, new THREE.Color());
    expect(hot.b / hot.r).toBeGreaterThan(0.4);
    expect(cool.g / cool.r).toBeLessThan(0.2);
    expect(hot.r).toBeGreaterThan(cool.r * 5);
  });
});

describe('flash', () => {
  test('every glare sprite is drawn from load, dark until a hit, and dark again after', () => {
    const flash = new FlashSystem();
    const sprites = flash.object.children.filter((c): c is THREE.Sprite => (c as THREE.Sprite).isSprite === true);
    expect(sprites.length).toBeGreaterThan(0);
    for (const s of sprites) {
      expect(s.visible).toBe(true);
      expect(s.frustumCulled).toBe(false);
      expect(s.scale.x).toBeLessThan(1e-3);
    }
    flash.flash(new THREE.Vector3(0, 1, 0), 900);
    expect(Math.max(...sprites.map((s) => s.scale.x))).toBeGreaterThan(0.05);
    for (let i = 0; i < 60; i++) flash.update(1 / 60);
    for (const s of sprites) {
      expect(s.visible).toBe(true);
      expect(s.scale.x).toBeLessThan(1e-3);
    }
  });
});

describe('event routing', () => {
  function systems() {
    const rng = makeRng(2);
    const fx = {
      sparks: new SparkSystem(rng),
      flash: new FlashSystem(),
      debris: new DebrisSystem(rng),
      smoke: new SmokeSystem(rng),
      com: (_c: 0 | 1, out: THREE.Vector3) => out.set(0, 1, 0),
    };
    return { fx, rng };
  }
  const impact = (over: Partial<Extract<SimEvent, { kind: 'impact' }>>): SimEvent => ({
    kind: 'impact', pos: [0, 0, 1.5], normal: [1, 0, 0], impulseNs: 100, speed: 8, energyJ: 900,
    striker: 1, victim: 0, part: 'head', metal: true, ...over,
  });
  test('a metal hit throws sparks and chips; a heavy one knocks debris loose', () => {
    const { fx, rng } = systems();
    routeEvent(impact({ energyJ: 900 }), fx, rng);
    expect(fx.sparks.alive).toBeGreaterThan(0);
    expect(fx.debris.total).toBeGreaterThan(0);
  });
  test('rubber-on-metal throws no sparks', () => {
    const { fx, rng } = systems();
    routeEvent(impact({ metal: false, energyJ: 100 }), fx, rng);
    expect(fx.sparks.alive).toBe(0);
  });
  test('a body slamming the canvas raises dust', () => {
    const { fx, rng } = systems();
    routeEvent(impact({ striker: null, pos: [0.5, 0, 0.05], speed: 4, metal: false }), fx, rng);
    expect(fx.smoke.alive).toBeGreaterThan(0);
  });
  test('a heavy hit that pushes the victim straight down still throws debris outward', () => {
    const { fx, rng } = systems();
    routeEvent(impact({ normal: [0, 0, -1], energyJ: 2000, metal: false }), fx, rng);
    const species = (fx.debris as unknown as { species: Array<{ pieces: Array<{ body: { vel: THREE.Vector3 } }> }> }).species;
    const speeds = species.flatMap((sp) => sp.pieces.map((p) => p.body.vel.length()));
    expect(speeds.length).toBeGreaterThan(0);
    expect(Math.min(...speeds)).toBeGreaterThan(0.1);
  });
  test('a detached head sheds bolts, sparks and smoke', () => {
    const { fx, rng } = systems();
    routeEvent({ kind: 'detach', corner: 0, part: 'head', debrisBody: 5, pos: [0, 0, 1.7], vel: [1, 0, 2] }, fx, rng);
    expect(fx.debris.total).toBeGreaterThanOrEqual(5);
    expect(fx.sparks.alive).toBeGreaterThan(0);
    expect(fx.smoke.alive).toBeGreaterThan(0);
  });
});

describe('telemetry emitters', () => {
  // Oil effects are a player setting, off by default; these tests exercise the emitter itself.
  beforeAll(() => setSetting('oilEffects', true));
  afterAll(() => setSetting('oilEffects', false));

  function setup() {
    const rng = makeRng(4);
    const smoke = new SmokeSystem(rng);
    const sprays: Array<{ pos: THREE.Vector3; dir: THREE.Vector3; speed: number; count: number }> = [];
    const oil = { spray: (pos: THREE.Vector3, dir: THREE.Vector3, speed: number, count: number) => sprays.push({ pos: pos.clone(), dir: dir.clone(), speed, count }) };
    const embers = { embers: () => {} };
    return { emitters: new TelemetryEmitters(rng, { smoke, oil, embers }), smoke, sprays };
  }
  test('leak rate sets the oil particle budget', () => {
    const { emitters, sprays } = setup();
    const leak = 0.5;
    emitters.setTelemetry([robot(0, [part('forearm_r', { leak, ventWorld: [0.1, -0.3, 1.1] })]), robot(1, [])], new Float32Array(0));
    for (let i = 0; i < 120; i++) emitters.update(1 / 60);
    const total = sprays.reduce((s, x) => s + x.count, 0);
    // Pump pulsation averages 0.4 + 0.6 × mean(|sin|³) ≈ 0.65 of the nominal rate.
    expect(total).toBeGreaterThan(leak * PARTICLES_PER_LITRE * 2 * 0.45);
    expect(total).toBeLessThan(leak * PARTICLES_PER_LITRE * 2 * 0.9);
    // Vent is converted to world space (physics y = -0.3 → world z = 0.3).
    expect(sprays[0].pos.z).toBeCloseTo(0.3, 5);
    expect(sprays[0].pos.y).toBeCloseTo(1.1, 5);
  });
  test('a low-pressure circuit dribbles instead of spurting', () => {
    const hi = setup();
    const lo = setup();
    const parts = [part('forearm_r', { leak: 0.5, ventWorld: [0.1, -0.3, 1.1] })];
    hi.emitters.setTelemetry([robot(0, parts, 1), robot(1, [])], new Float32Array(0));
    lo.emitters.setTelemetry([robot(0, parts, 0.05), robot(1, [])], new Float32Array(0));
    for (let i = 0; i < 30; i++) { hi.emitters.update(1 / 60); lo.emitters.update(1 / 60); }
    const avg = (s: typeof hi.sprays) => s.reduce((a, x) => a + x.speed, 0) / s.length;
    expect(avg(lo.sprays)).toBeLessThan(avg(hi.sprays) * 0.5);
  });
  test('clear() stops emission until fresh telemetry arrives', () => {
    const { emitters, smoke, sprays } = setup();
    emitters.setTelemetry([robot(0, [part('forearm_r', { smoke: 1, leak: 0.5, ventWorld: [0.1, -0.3, 1.1] })]), robot(1, [])], new Float32Array(0));
    for (let i = 0; i < 10; i++) emitters.update(1 / 60);
    expect(smoke.alive).toBeGreaterThan(0);
    smoke.clear();
    emitters.clear();
    sprays.length = 0;
    for (let i = 0; i < 30; i++) emitters.update(1 / 60);
    expect(smoke.alive).toBe(0);
    expect(sprays.length).toBe(0);
  });
  test('without a vent, smoke follows the part body from the pose buffer', () => {
    const { emitters, smoke } = setup();
    const meta: WorldMeta = { nbody: 3, timestep: 0.001, props: [], robots: [
      { corner: 0, design: 'bruiser', prefix: 'r0_', parts: [{ id: 'torso', body: 2, debrisBody: null }] },
    ] };
    emitters.setWorld(meta);
    const poses = new Float32Array(3 * 7);
    poses.set([2, -1, 1.4, 1, 0, 0, 0], 2 * 7);
    emitters.setTelemetry([robot(0, [part('torso', { smoke: 1, heat: 0.5 })]), robot(1, [])], poses);
    for (let i = 0; i < 10; i++) emitters.update(1 / 60);
    smoke.update(0, camera);
    expect(smoke.alive).toBeGreaterThan(0);
    const pos = smoke.object.geometry.getAttribute('iPos').array as Float32Array;
    expect(pos[0]).toBeCloseTo(2, 0);
    expect(pos[2]).toBeCloseTo(1, 0); // physics y = -1 → world z = +1
  });
});

describe('fallback oil', () => {
  test('droplets land and pool into a puddle that keeps their volume', () => {
    const oil = new FallbackOil(makeRng(5));
    oil.spray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0.3, 0).normalize(), 3, 400, 0.05, new THREE.Vector3());
    expect(oil.activeParticles).toBe(400);
    for (let i = 0; i < 180; i++) oil.update(1 / 60);
    expect(oil.activeParticles).toBe(0);
    const puddles = (oil as unknown as { puddles: Array<{ volume: number; radius: number }> }).puddles;
    const volume = puddles.reduce((s, p) => s + p.volume, 0);
    expect(volume).toBeCloseTo(400e-6, 9);
    expect(puddles.length).toBeLessThan(10); // a stream pools, it doesn't scatter into 400 spots
    expect(Math.max(...puddles.map((p) => p.radius))).toBeGreaterThan(0.1);
  });
});
