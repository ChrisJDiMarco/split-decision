// Physical dents on the kit (docs/design/strike-power.md §4.2): the physics publishes each dent in the
// struck part's frame; the kit draws each one once, at the contact point, with a cumulative cap and the
// labelled presentation boost (settings.dentBoost).
import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { DentTelemetry, RobotTelemetry } from '../../src/core/protocol';
import { setSetting, settings } from '../../src/core/settings';
import { DENT_VISUAL_BOOST, applyImpact, syncDents, updateRobotKit } from '../../src/render/robot-kit';
import { MAX_CUMULATIVE_DEPTH_M } from '../../src/render/robot-kit/damage';
import { buildTestRobot, poseRobot } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

/** The most forward paint vertex of the torso, in the torso's own frame: where a straight shot lands. */
function chestPoint(r: ReturnType<typeof buildTestRobot>) {
  const torso = r.view.parts.get('torso')!;
  const paint = torso.meshes.find((m) => m.userData.slot === 'paint')!;
  const pos = paint.geometry.getAttribute('position');
  let best = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getX(i) > pos.getX(best)) best = i;
  const world = new THREE.Vector3().fromBufferAttribute(pos, best).applyMatrix4(paint.matrixWorld);
  const local = torso.attached.worldToLocal(world.clone());
  return { torso, paint, best, local };
}

function maxInward(before: Float32Array, after: Float32Array): number {
  let m = 0;
  for (let i = 0; i < before.length; i += 3) m = Math.max(m, before[i] - after[i]); // pushed back along −x
  return m;
}

function dent(seq: number, local: THREE.Vector3, depthM: number, over: Partial<DentTelemetry> = {}): DentTelemetry {
  return { seq, part: 'torso', pos: [local.x, local.y, local.z], normal: [1, 0, 0], depthM, radiusM: 0.05, mode: 'dent', cracked: false, whiten: 0, ...over };
}

describe('physical dents', () => {
  test('each dent seq is drawn once, at the contact point, boosted only for presentation', () => {
    const boost = settings().dentBoost;
    setSetting('dentBoost', false);
    try {
      const r = buildTestRobot('savate');
      poseRobot(r);
      const { paint, local } = chestPoint(r);
      const pos = paint.geometry.getAttribute('position');
      const before = Float32Array.from(pos.array as Float32Array);
      syncDents(r.view, [dent(1, local, 0.004)]);
      const once = Float32Array.from(pos.array as Float32Array);
      const depth1 = maxInward(before, once);
      expect(depth1).toBeGreaterThan(0.002);
      expect(depth1).toBeLessThan(0.004 * 1.31); // physical depth (the crumple noise is ±30%)
      syncDents(r.view, [dent(1, local, 0.004)]); // a replayed frame: nothing new
      expect(Array.from(pos.array as Float32Array)).toEqual(Array.from(once));

      setSetting('dentBoost', true);
      const r2 = buildTestRobot('savate');
      poseRobot(r2);
      const c2 = chestPoint(r2);
      const pos2 = c2.paint.geometry.getAttribute('position');
      const b2 = Float32Array.from(pos2.array as Float32Array);
      syncDents(r2.view, [dent(1, c2.local, 0.004)]);
      const depth2 = maxInward(b2, pos2.array as Float32Array);
      expect(depth2 / depth1).toBeGreaterThan(0.8 * DENT_VISUAL_BOOST);
      expect(depth2 / depth1).toBeLessThan(1.2 * DENT_VISUAL_BOOST);
    } finally {
      setSetting('dentBoost', boost);
    }
  });

  test('repeat dents on one spot stop at the cumulative cap', () => {
    const r = buildTestRobot('firecracker');
    poseRobot(r);
    const { paint, local } = chestPoint(r);
    const pos = paint.geometry.getAttribute('position');
    const before = Float32Array.from(pos.array as Float32Array);
    syncDents(r.view, Array.from({ length: 8 }, (_, k) => dent(k + 1, local, 0.02)));
    expect(maxInward(before, pos.array as Float32Array)).toBeLessThanOrEqual(MAX_CUMULATIVE_DEPTH_M + 1e-6);
  });

  test('a crack chips a line and whitening marks the shell; a crack barely moves it', () => {
    const r = buildTestRobot('pylon');
    poseRobot(r);
    const { paint, local } = chestPoint(r);
    const dmg = paint.geometry.getAttribute('aDamage');
    const pos = paint.geometry.getAttribute('position');
    const before = Float32Array.from(pos.array as Float32Array);
    syncDents(r.view, [dent(1, local, 0.003, { mode: 'crack', cracked: true, whiten: 0.7, radiusM: 0.06 })]);
    let chipped = 0, white = 0;
    for (let i = 0; i < dmg.count; i++) {
      if (dmg.getZ(i) >= 1) chipped++;
      if (dmg.getW(i) > 0.3) white++;
    }
    expect(chipped).toBeGreaterThan(0);
    expect(white).toBeGreaterThan(chipped);
    expect(maxInward(before, pos.array as Float32Array)).toBeLessThan(0.01);
  });

  test('once physics dents stream in, applyImpact only scuffs (no double dents); without them it still dents', () => {
    const tel = (r: ReturnType<typeof buildTestRobot>, dents: DentTelemetry[]): RobotTelemetry => ({
      corner: r.view.corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
      battery: 1, gyroHealth: 1, gyroSaturation: 0, hydraulicPressure: {}, skill: 'idle', skillPhase: 0, windup: 0,
      parts: [...r.view.parts.values()].map((k) => ({ id: k.id, hp: 1, smoke: 0, heat: 0, attached: true, leak: 0 })), joints: [], damageTotal: 0, intent: null, dents,
    });
    const physical = buildTestRobot('savate');
    poseRobot(physical);
    updateRobotKit([physical.view], [tel(physical, [])], 1 / 60); // physics telemetry, no dents yet
    const a = chestPoint(physical);
    const posA = a.paint.geometry.getAttribute('position');
    const beforeA = Float32Array.from(posA.array as Float32Array);
    const world = a.local.clone().applyMatrix4(a.torso.attached.matrixWorld);
    const normal = new THREE.Vector3(1, 0, 0).transformDirection(a.torso.attached.matrixWorld);
    applyImpact(physical.view, 'torso', world, normal, 400);
    expect(maxInward(beforeA, posA.array as Float32Array)).toBe(0);
    expect((a.paint.geometry.getAttribute('aDamage').array as Float32Array).some((v) => v > 0)).toBe(true); // scuffed

    const harness = buildTestRobot('savate');
    poseRobot(harness);
    const b = chestPoint(harness);
    const posB = b.paint.geometry.getAttribute('position');
    const beforeB = Float32Array.from(posB.array as Float32Array);
    applyImpact(harness.view, 'torso', b.local.clone().applyMatrix4(b.torso.attached.matrixWorld), normal, 400);
    expect(maxInward(beforeB, posB.array as Float32Array)).toBeGreaterThan(0.004);
  });
});
