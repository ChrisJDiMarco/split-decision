import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Profile } from './bench';

const BUDGET_US = 60;
const fmt = (p: Profile) => `damage ${p.damageUs.toFixed(1)} µs/step, whole step ${p.stepUs.toFixed(0)} µs, ` +
  `contacts mean ${p.meanContacts.toFixed(1)} max ${p.maxContacts}, ${p.impacts} impact events`;

describe('damage system cost', () => {
  // Timed in a plain Node child process: vitest's worker slows WASM calls ~4x, which would measure the harness.
  it(`stays under ${BUDGET_US} µs per step standing, and in a collapsed heap under fire`, () => {
    const out = execFileSync('npx', ['tsx', 'tests/damage/bench.ts'], { encoding: 'utf8', timeout: 120_000 });
    const { standing, heap } = JSON.parse(out.trim().split('\n').pop()!) as { standing: Profile; heap: Profile };
    console.info(`[perf] standing: ${fmt(standing)}`);
    console.info(`[perf] both robots collapsed in a heap + ram every 60 ms: ${fmt(heap)}`);
    expect(standing.damageUs).toBeLessThan(BUDGET_US);
    expect(heap.damageUs).toBeLessThan(BUDGET_US);
    expect(heap.impacts).toBeGreaterThan(20);
  }, 150_000);
});
