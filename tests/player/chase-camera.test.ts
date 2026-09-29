import { describe, expect, it } from 'vitest';
import { APOTHEM } from '../../src/core/arena-spec';
import type { Vec3 } from '../../src/core/types';
import { clearLens, lockYaw, solveChase, type ChaseSubjects } from '../../src/player/chase-camera';
import { CHASE } from '../../src/player/config';
import { insideCage } from '../../src/render/camera/sightlines';

const subjects = (me: Vec3, opp: Vec3, down = false): ChaseSubjects => ({ me, meHeadZ: 1.6, opp, oppHeadZ: 1.7, down });
const view = { yawOffset: 0, pitch: CHASE.PITCH_RAD };

describe('chase camera', () => {
  it('sits behind the player on the lock-on line, over the right shoulder, full boom in open space', () => {
    const s = subjects([-1, 0, 0.9], [1, 0, 0.9]);
    const p = solveChase(s, view, lockYaw(s.me, s.opp));
    expect(p.boomShare).toBeCloseTo(1);
    expect(p.swing).toBe(0);
    expect(p.pos[0]).toBeLessThan(-2.5); // behind me (I face +x)
    expect(p.pos[1]).toBeLessThan(0); // my right is -y
    expect(p.target[0]).toBeGreaterThan(0); // aimed past me at him
    expect(clearLens(p.pos, p.pivot, p.target)).toBe(true);
  });

  it('pulls in or swings around (and stays inside the fence) when the player is backed onto the cage', () => {
    const me: Vec3 = [-(APOTHEM - 0.45), 0, 0.9];
    const s = subjects(me, [0, 0, 0.9]);
    const p = solveChase(s, view, lockYaw(s.me, s.opp));
    expect(p.boomShare < 1 || p.swing !== 0).toBe(true);
    expect(p.boomShare).toBeGreaterThan(0);
    expect(insideCage(p.pos, CHASE.CAGE_INSET_M - 1e-6)).toBe(true);
    expect(clearLens(p.pos, p.pivot, p.target)).toBe(true);
  });

  it('finds a clear lens all around the cage, at every bearing and orbit', () => {
    let fallbacks = 0;
    let n = 0;
    for (let r = 0; r <= APOTHEM - 0.4; r += 0.6) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        for (const off of [-CHASE.YAW_LIMIT_RAD, 0, CHASE.YAW_LIMIT_RAD]) {
          const me: Vec3 = [Math.cos(a) * r, Math.sin(a) * r, 0.9];
          const opp: Vec3 = [me[0] + Math.cos(a + 2) * 1.1, me[1] + Math.sin(a + 2) * 1.1, 0.9];
          const s = subjects(me, opp, r > 2);
          const p = solveChase(s, { yawOffset: off, pitch: CHASE.PITCH_RAD }, lockYaw(me, opp));
          n++;
          if (p.boomShare === 0) fallbacks++;
          else expect(clearLens(p.pos, p.pivot, p.target)).toBe(true);
          expect(p.pos[2]).toBeGreaterThan(0.3);
        }
      }
    }
    expect(fallbacks).toBe(0);
  });

  it('holds its choice while pinned on the fence instead of hopping between near-equal views', () => {
    // A fighter pressed onto a panel, sliding along it and swaying, as frames go by.
    let prev: ReturnType<typeof solveChase> | null = null;
    let side: 1 | -1 = 1;
    let hops = 0;
    let jumps = 0;
    for (let k = 0; k < 400; k++) {
      const along = -0.6 + k * 0.003;
      const r = APOTHEM - 0.45 + 0.04 * Math.sin(k * 0.3);
      const n = Math.PI / 8;
      const me: Vec3 = [Math.cos(n) * r - Math.sin(n) * along, Math.sin(n) * r + Math.cos(n) * along, 0.8];
      const oa = n + Math.PI + 0.3 * Math.sin(k * 0.05);
      const opp: Vec3 = [me[0] + Math.cos(oa) * 0.95, me[1] + Math.sin(oa) * 0.95, 0.8];
      const s = { ...subjects(me, opp), meHeadZ: 1.6 + 0.03 * Math.sin(k * 0.7) };
      const p = solveChase(s, view, lockYaw(me, opp), side, prev);
      expect(p.boomShare === 0 || clearLens(p.pos, p.pivot, p.target)).toBe(true);
      if (p.swing !== 0) side = p.swing > 0 ? 1 : -1;
      if (prev && (p.swing !== prev.swing || p.lift !== prev.lift)) hops++;
      if (prev && Math.abs(p.pos[2] - prev.pos[2]) > 0.3) jumps++;
      prev = p;
    }
    // Without keeping the previous choice this slide hopped 24 times, 22 of them lurching the lens > 0.3 m up or down.
    expect(hops).toBeLessThanOrEqual(6);
    expect(jumps).toBeLessThanOrEqual(3);
  });
});
