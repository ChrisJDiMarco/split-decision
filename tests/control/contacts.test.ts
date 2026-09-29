// Contact scans: anyContact must find real contacts and must not leak the WASM heap (every
// element MuJoCo's contact vector hands out is a heap copy that has to be deleted).
import { describe, expect, it } from 'vitest';
import { anyContact } from '../../src/physics/control/contacts';
import { makeSim } from './helpers';

const SCANS = 20_000; // ~0.7 KB per undeleted element: a leak would add well over 100 MB
const MAX_HEAP_GROWTH_BYTES = 4e6;

describe('contact scans', () => {
  it('find the feet on the canvas without growing the heap', async () => {
    const sim = await makeSim({ design: 'striker', x: -1, y: 0, yaw: 0 }, { design: 'bruiser', x: 1, y: 0, yaw: Math.PI });
    const { ctx } = sim;
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    sim.seconds(0.5);
    const canvas = ctx.model.geom('canvas').id as number;
    const heap = () => (ctx.data.qpos as Float64Array).buffer.byteLength;

    expect(ctx.data.ncon).toBeGreaterThan(0);
    expect(anyContact(ctx.data, (a, b) => a === canvas || b === canvas)).toBe(true);
    expect(anyContact(ctx.data, () => false)).toBe(false);

    const before = heap();
    for (let i = 0; i < SCANS; i++) anyContact(ctx.data, () => false);
    expect(heap() - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    sim.dispose();
  }, 120_000);
});
