import { describe, expect, it } from 'vitest';
import { damageState, damageSystem } from '../../src/physics/damage';
import { makeRig, step } from './helpers';

interface Handle { isDeleted(): boolean }

describe('WASM memory', () => {
  it('frees every MjContact copy it reads (each one is ~0.7 KB of heap per contact per step)', () => {
    const ctx = makeRig();
    step(ctx, 300); // settled: feet on the canvas
    const probe = ctx.data.contact;
    const proto = Object.getPrototypeOf(probe) as { get(i: number): Handle };
    probe.delete();
    const original = proto.get;
    const handed: Handle[] = [];
    proto.get = function get(this: unknown, i: number) {
      const c = original.call(this, i);
      handed.push(c);
      return c;
    };
    try {
      for (let k = 0; k < 20; k++) {
        ctx.mj.mj_step(ctx.model, ctx.data);
        ctx.tick++;
        damageSystem.post!(ctx);
      }
    } finally {
      proto.get = original;
    }
    expect(handed.length).toBeGreaterThan(20); // standing robots: feet on the canvas every step
    expect(handed.filter((c) => !c.isDeleted())).toHaveLength(0);
  });

  it('shares one out-parameter buffer across contexts, so a reset does not leak one', () => {
    const a = makeRig();
    const b = makeRig();
    expect(damageState(a).velBuf).toBe(damageState(b).velBuf);
  });
});
