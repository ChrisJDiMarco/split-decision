import { describe, expect, it } from 'vitest';
import { APOTHEM, ARENA, panels } from '../../src/core/arena-spec';
import { BLUE_CORNER_POST, RED_CORNER_POST, gatePanels } from '../../src/render/arena/cage';
import { buildFence } from '../../src/render/arena/fence';
import { physicsToWorld, seededRandom } from '../../src/render/arena/util';

const FRAME = 1 / 60;

function run(update: (dt: number) => void, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) update(FRAME);
}

describe('fence bow', () => {
  it('bows the panel nearest the impact outward and leaves the others still', () => {
    const fence = buildFence();
    const target = panels().findIndex((p) => Math.abs(Math.sin(p.normalAngle) + 1) < 1e-6); // the -y side
    fence.bow([0.3, -APOTHEM + 0.1, 1.0], 1);
    run(fence.update, 0.1);
    fence.panels.forEach((p, i) => {
      if (i === target) expect(p.amp).toBeGreaterThan(0.05);
      else expect(p.amp).toBe(0);
    });
    expect(fence.panels[target].impact.x).toBeCloseTo(0.3, 5); // local +x runs along physics +x on this side
    expect(fence.panels[target].impact.y).toBeCloseTo(1.0, 5);
  });

  it('springs back to rest', () => {
    const fence = buildFence();
    fence.bow([APOTHEM - 0.05, 0.2, 0.8], 2);
    run(fence.update, 4);
    for (const p of fence.panels) {
      expect(Math.abs(p.amp)).toBeLessThan(1e-3);
    }
  });

  it('never stretches past its limit, however hard the hit', () => {
    const fence = buildFence();
    let peak = 0;
    for (let k = 0; k < 30; k++) {
      fence.bow([APOTHEM, 0, 1], 50);
      fence.update(FRAME);
      for (const p of fence.panels) peak = Math.max(peak, p.amp);
    }
    expect(peak).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('ignores impacts far from the fence, zero or invalid strength', () => {
    const fence = buildFence();
    fence.bow([0, 0, 1], 1); // centre of the cage
    fence.bow([APOTHEM, 0, 1], 0);
    fence.bow([APOTHEM, 0, 1], Number.NaN);
    run(fence.update, 0.2);
    for (const p of fence.panels) expect(p.amp).toBe(0);
  });

  it('survives a NaN frame time and a non-finite impact point', () => {
    const fence = buildFence();
    fence.bow([APOTHEM, 0, Number.NaN], 1); // ignored: would poison the impact uniform
    for (const p of fence.panels) expect(Number.isFinite(p.impact.y)).toBe(true);
    fence.bow([APOTHEM, 0, 1], 1);
    fence.update(Number.NaN); // skipped, not stuck at NaN
    run(fence.update, 0.1);
    const moving = fence.panels.filter((p) => p.amp !== 0);
    expect(moving.length).toBe(1);
    expect(Number.isFinite(moving[0].amp)).toBe(true);
    run(fence.update, 4);
    for (const p of fence.panels) expect(Math.abs(p.amp)).toBeLessThan(1e-3);
  });

  it('accepts three.js vectors as well as tuples', () => {
    const fence = buildFence();
    fence.bow({ x: APOTHEM, y: 0.1, z: 1 } as unknown as import('three/webgpu').Vector3, 1);
    run(fence.update, 0.05);
    expect(fence.panels.some((p) => p.amp > 0)).toBe(true);
  });
});

describe('cage layout', () => {
  it('puts the two gates on opposite sides, away from the fighters', () => {
    const [a, b] = gatePanels();
    const ps = panels();
    expect(Math.abs(ps[a].normalAngle - ps[b].normalAngle)).toBeCloseTo(Math.PI, 6);
    // Fighters spawn on the x axis; gate normals point mostly along y.
    expect(Math.abs(Math.sin(ps[a].normalAngle))).toBeGreaterThan(0.9);
  });

  it('colours the posts behind each fighter: red on -x, blue on +x', () => {
    expect(ARENA.SIDES % 2).toBe(0);
    const angle = (i: number) => ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    expect(Math.cos(angle(RED_CORNER_POST))).toBeLessThan(-0.9);
    expect(Math.cos(angle(BLUE_CORNER_POST))).toBeGreaterThan(0.9);
  });
});

describe('helpers', () => {
  it('seeded random is deterministic and in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('maps physics z-up to three.js y-up', () => {
    const v = physicsToWorld(1, 2, 3);
    expect([v.x, v.y, v.z]).toEqual([1, 3, -2]);
  });
});
