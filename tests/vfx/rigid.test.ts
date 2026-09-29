import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { boltShape, nutShape, shardShape } from '../../src/render/vfx/debris-geometry';
import { makeRng } from '../../src/render/vfx/coords';
import { makeBody, stepBody, type RigidBody } from '../../src/render/vfx/rigid';

const env = { fenceRadius: 4.2 };
const DT = 1 / 120;

function simulate(b: RigidBody, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) stepBody(b, DT, env);
}

function lowestPoint(b: RigidBody): number {
  let min = Infinity;
  for (const p of b.support) min = Math.min(min, p.clone().applyQuaternion(b.quat).y + b.pos.y);
  return min;
}

describe('debris rigid bodies', () => {
  test('a tumbling bolt thrown upward lands, settles and sleeps on the canvas', () => {
    const shape = boltShape();
    const b = makeBody(shape.support, shape.radius, shape.massKg, { restitution: 0.35, friction: 0.45 });
    b.pos.set(0, 1.5, 0);
    b.vel.set(1.5, 2.5, -0.5);
    b.angVel.set(12, -20, 7);
    simulate(b, 4);
    expect(b.asleep).toBe(true);
    // Resting on the canvas: lowest hull point at the floor, never sunk into it.
    expect(lowestPoint(b)).toBeGreaterThan(-0.004);
    expect(lowestPoint(b)).toBeLessThan(0.004);
  });

  test('a bolt comes to rest lying on its side, not balanced on end', () => {
    const shape = boltShape(0.075, 0.01);
    const b = makeBody(shape.support, shape.radius, shape.massKg);
    b.pos.set(0, 0.3, 0);
    b.quat.setFromEuler(new THREE.Euler(0.4, 0, 0.3));
    b.angVel.set(3, 1, -2);
    simulate(b, 5);
    expect(b.asleep).toBe(true);
    // Its centre sits close to the canvas (a head radius up), far below half its length.
    expect(b.pos.y).toBeLessThan(0.03);
  });

  test('pieces never leave the cage', () => {
    const rng = makeRng(3);
    const shape = shardShape(rng, new THREE.Vector3(0.06, 0.015, 0.05));
    const b = makeBody(shape.support, shape.radius, shape.massKg);
    b.pos.set(3.8, 0.5, 0);
    b.vel.set(9, 1, 0);
    simulate(b, 3);
    expect(Math.hypot(b.pos.x, b.pos.z)).toBeLessThanOrEqual(env.fenceRadius);
  });

  test('a nut dropped flat does not bounce forever', () => {
    const shape = nutShape();
    const b = makeBody(shape.support, shape.radius, shape.massKg, { restitution: 0.35 });
    b.pos.set(0, 2, 0);
    simulate(b, 3);
    expect(b.asleep).toBe(true);
    expect(b.vel.length()).toBe(0);
  });
});
